// 설계 단계에서 예상한 문제를 단순한 구현과 채택한 구현으로 각각 재현해 수치로 비교함
// 사용법: npm run bench:design
const fs = require('fs')
const os = require('os')
const path = require('path')
const { performance } = require('perf_hooks')
const { MongoClient, ObjectId } = require('mongodb')
const { MongoMemoryServer } = require('mongodb-memory-server')
const db = require('../src/db')
const { seed } = require('./seed')
const { recordClientEvents } = require('../src/services/events')
const popular = require('../src/services/popular')
const { WEIGHTS } = require('../src/services/scoring')

const cleanupTasks = []
async function cleanup() {
  while (cleanupTasks.length > 0) {
    try {
      await cleanupTasks.pop()()
    } catch {
      // 정리 중 오류는 무시
    }
  }
}
process.on('SIGINT', () => cleanup().finally(() => process.exit(130)))

const round1 = (n) => Math.round(n * 10) / 10

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function timeMedian(fn, runs = 15, warmup = 3) {
  for (let i = 0; i < warmup; i++) await fn()
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  return round1(median(times))
}

// 1. 같은 아이디로 동시에 가입
async function signupRace(d) {
  const concurrency = 50
  const rounds = 100
  const naive = d.collection('signup_naive')
  const unique = d.collection('signup_unique')
  await unique.createIndex({ username: 1 }, { unique: true })

  let naiveDocs = 0
  let naiveBad = 0
  let uniqueDocs = 0
  let uniqueBad = 0
  for (let r = 0; r < rounds; r++) {
    const username = `user${r}`
    // 단순한 구현: 조회해서 없으면 저장
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        if (!(await naive.findOne({ username }))) await naive.insertOne({ username })
      }),
    )
    const a = await naive.countDocuments({ username })
    naiveDocs += a
    if (a > 1) naiveBad++

    // 채택한 구현: 바로 저장하고 고유 인덱스가 거름
    await Promise.allSettled(Array.from({ length: concurrency }, () => unique.insertOne({ username })))
    const b = await unique.countDocuments({ username })
    uniqueDocs += b
    if (b > 1) uniqueBad++
  }
  return {
    concurrency,
    rounds,
    naive: { roundsWithDuplicate: naiveBad, avgAccountsCreated: round1(naiveDocs / rounds) },
    adopted: { roundsWithDuplicate: uniqueBad, avgAccountsCreated: round1(uniqueDocs / rounds) },
  }
}

// 2. 한 사람이 공감 버튼을 동시에 연타
async function likeRace(d) {
  const concurrency = 20
  const rounds = 100
  const posts = d.collection('like_posts')
  const naiveLikes = d.collection('like_naive')
  const uniqueLikes = d.collection('like_unique')
  await uniqueLikes.createIndex({ postId: 1, userId: 1 }, { unique: true })

  const result = { naive: { sumCount: 0, wrongRounds: 0 }, adopted: { sumCount: 0, wrongRounds: 0 } }
  for (let r = 0; r < rounds; r++) {
    const userId = new ObjectId()

    const naivePost = new ObjectId()
    await posts.insertOne({ _id: naivePost, likeCount: 0 })
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        // 단순한 구현: 조회해서 공감한 적 없으면 저장하고 숫자 증가
        if (!(await naiveLikes.findOne({ postId: naivePost, userId }))) {
          await naiveLikes.insertOne({ postId: naivePost, userId })
          await posts.updateOne({ _id: naivePost }, { $inc: { likeCount: 1 } })
        }
      }),
    )
    const n = (await posts.findOne({ _id: naivePost })).likeCount
    result.naive.sumCount += n
    if (n !== 1) result.naive.wrongRounds++

    const adoptedPost = new ObjectId()
    await posts.insertOne({ _id: adoptedPost, likeCount: 0 })
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        // 채택한 구현: 바로 저장하고 새로 생긴 경우에만 증가
        try {
          await uniqueLikes.insertOne({ postId: adoptedPost, userId })
          await posts.updateOne({ _id: adoptedPost }, { $inc: { likeCount: 1 } })
        } catch (err) {
          if (err.code !== 11000) throw err
        }
      }),
    )
    const a = (await posts.findOne({ _id: adoptedPost })).likeCount
    result.adopted.sumCount += a
    if (a !== 1) result.adopted.wrongRounds++
  }
  return {
    concurrency,
    rounds,
    expectedCount: 1,
    naive: { avgLikeCount: round1(result.naive.sumCount / rounds), wrongRounds: result.naive.wrongRounds },
    adopted: { avgLikeCount: round1(result.adopted.sumCount / rounds), wrongRounds: result.adopted.wrongRounds },
  }
}

// 3. 같은 댓글 삭제 요청이 동시에 들어옴
async function commentDeleteRace(d) {
  const concurrency = 5
  const rounds = 100
  const initialCount = 10
  const posts = d.collection('cmt_posts')
  const comments = d.collection('cmt_comments')

  const result = { naive: { sum: 0, wrong: 0 }, adopted: { sum: 0, wrong: 0 } }
  for (const mode of ['naive', 'adopted']) {
    for (let r = 0; r < rounds; r++) {
      const postId = new ObjectId()
      const commentId = new ObjectId()
      await posts.insertOne({ _id: postId, commentCount: initialCount })
      await comments.insertOne({ _id: commentId, postId, deletedAt: null })

      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          if (mode === 'naive') {
            // 단순한 구현: 아직 안 지워졌으면 지우고 무조건 감소
            const c = await comments.findOne({ _id: commentId, deletedAt: null })
            if (c) {
              await comments.updateOne({ _id: commentId }, { $set: { deletedAt: new Date() } })
              await posts.updateOne({ _id: postId }, { $inc: { commentCount: -1 } })
            }
          } else {
            // 채택한 구현: 실제로 바뀐 요청만 감소
            const res = await comments.updateOne({ _id: commentId, deletedAt: null }, { $set: { deletedAt: new Date() } })
            if (res.modifiedCount === 1) await posts.updateOne({ _id: postId }, { $inc: { commentCount: -1 } })
          }
        }),
      )
      const count = (await posts.findOne({ _id: postId })).commentCount
      result[mode].sum += count
      if (count !== initialCount - 1) result[mode].wrong++
    }
  }
  return {
    concurrency,
    rounds,
    expectedCount: initialCount - 1,
    naive: { avgCommentCount: round1(result.naive.sum / rounds), wrongRounds: result.naive.wrong },
    adopted: { avgCommentCount: round1(result.adopted.sum / rounds), wrongRounds: result.adopted.wrong },
  }
}

// 4. 글 20만 개에서 깊은 페이지로 이동
async function pagination(client) {
  const d = client.db('dv_page')
  const postsTotal = 200000
  const pageSize = 20
  await seed(d, { users: 100, posts: postsTotal, events: 100, days: 7 })
  const posts = d.collection('posts')

  const rows = []
  for (const page of [1, 100, 1000, 5000, 10000]) {
    const skip = (page - 1) * pageSize
    const skipQuery = () => posts.find({ deletedAt: null }).sort({ _id: -1 }).skip(skip).limit(pageSize)

    let cursorQuery = skipQuery
    if (skip > 0) {
      // 이전 페이지의 마지막 글 id를 커서로 사용
      const [prev] = await posts.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).skip(skip - 1).limit(1).toArray()
      cursorQuery = () => posts.find({ deletedAt: null, _id: { $lt: prev._id } }).sort({ _id: -1 }).limit(pageSize + 1)
    } else {
      cursorQuery = () => posts.find({ deletedAt: null }).sort({ _id: -1 }).limit(pageSize + 1)
    }

    const skipDocs = (await skipQuery().explain('executionStats')).executionStats.totalDocsExamined
    const cursorDocs = (await cursorQuery().explain('executionStats')).executionStats.totalDocsExamined
    rows.push({
      page,
      skip: { ms: await timeMedian(() => skipQuery().toArray()), docsExamined: skipDocs },
      cursor: { ms: await timeMedian(() => cursorQuery().toArray()), docsExamined: cursorDocs },
    })
  }
  return { postsTotal, pageSize, rows }
}

// 5. 피드 한 페이지(글 20개)의 공감 수, 댓글 수를 읽는 방법
async function denormalization(d) {
  const feedSize = 20
  const likesPerPost = 5000
  const commentsPerPost = 1000
  const posts = d.collection('dn_posts')
  const likes = d.collection('dn_likes')
  const comments = d.collection('dn_comments')
  await likes.createIndex({ postId: 1, userId: 1 }, { unique: true })
  await comments.createIndex({ postId: 1, _id: 1 })

  const ids = Array.from({ length: feedSize }, () => new ObjectId())
  await posts.insertMany(ids.map((_id) => ({ _id, title: '글', likeCount: likesPerPost, commentCount: commentsPerPost })))
  for (const postId of ids) {
    await likes.insertMany(Array.from({ length: likesPerPost }, () => ({ postId, userId: new ObjectId() })), { ordered: false })
    await comments.insertMany(Array.from({ length: commentsPerPost }, () => ({ postId, deletedAt: null })), { ordered: false })
  }

  // 글에 저장한 숫자를 그대로 읽음
  const readStored = () => posts.find({ _id: { $in: ids } }).toArray()
  // 글마다 공감, 댓글 개수를 세는 쿼리를 따로 보냄
  const readCounted = async () => {
    const list = await posts.find({ _id: { $in: ids } }).toArray()
    return Promise.all(
      list.map(async (p) => ({
        ...p,
        likeCount: await likes.countDocuments({ postId: p._id }),
        commentCount: await comments.countDocuments({ postId: p._id, deletedAt: null }),
      })),
    )
  }
  const storedMs = await timeMedian(readStored, 30)
  const countedMs = await timeMedian(readCounted, 30)

  // 쓰기 비용: 숫자를 함께 갱신하면 공감 한 번에 쓰기가 하나 더 듦
  const writes = 3000
  const costPost = new ObjectId()
  await posts.insertOne({ _id: costPost, likeCount: 0 })
  const t0 = performance.now()
  for (let i = 0; i < writes; i++) await likes.insertOne({ postId: costPost, userId: new ObjectId() })
  const insertOnlyMs = (performance.now() - t0) / writes
  const t1 = performance.now()
  for (let i = 0; i < writes; i++) {
    await likes.insertOne({ postId: costPost, userId: new ObjectId() })
    await posts.updateOne({ _id: costPost }, { $inc: { likeCount: 1 } })
  }
  const insertAndIncMs = (performance.now() - t1) / writes

  return {
    feedSize,
    likesPerPost,
    commentsPerPost,
    read: { storedMs, countedMs, queriesStored: 1, queriesCounted: 1 + feedSize * 2 },
    writePerLike: { insertOnlyMs: round1(insertOnlyMs * 100) / 100, insertAndIncMs: round1(insertAndIncMs * 100) / 100 },
  }
}

// 6. 브라우저가 보내는 이벤트를 조작하는 경우
async function eventTampering(uri) {
  await db.connect(uri, 'dv_events')
  const d = db.getDb()
  const forgedCount = 1000
  const now = new Date()
  const mkPost = () => ({ _id: new ObjectId(), title: '글', board: 'free', authorNickname: 'a', content: 'c', imageUrls: [], likeCount: 0, commentCount: 0, createdAt: now, updatedAt: now, deletedAt: null })

  const normal = [mkPost(), mkPost(), mkPost()]
  const target = mkPost()
  await d.collection('posts').insertMany([...normal, target])
  const real = (postId, n) =>
    Array.from({ length: n }, () => ({ type: 'view', userId: null, postId, surface: 'detail', position: null, occurredAt: now, receivedAt: now, source: 'server' }))
  await d.collection('events').insertMany([...real(normal[0]._id, 30), ...real(normal[1]._id, 20), ...real(normal[2]._id, 10)])

  const forged = (type) =>
    Array.from({ length: forgedCount }, () => ({ type, postId: String(target._id), surface: 'feed_latest', position: 0, occurredAt: now.toISOString() }))
  const scoreOf = async () => {
    const list = await popular.getPopularPostsFromEvents({ now: new Date(now.getTime() + 1000) })
    const idx = list.findIndex((p) => p._id.equals(target._id))
    return { rank: idx < 0 ? null : idx + 1, score: idx < 0 ? 0 : list[idx].stats.score }
  }

  const before = await scoreOf()

  // 채택한 구현: 검증 후 저장
  const forgedLikes = await recordClientEvents(null, forged('like'))
  const afterAdoptedLikes = await scoreOf()
  const forgedImpressions = await recordClientEvents(null, forged('impression'))
  const afterAdoptedImpressions = await scoreOf()

  // 단순한 구현: 받은 값을 검사 없이 그대로 저장
  await d.collection('events').insertMany(
    forged('like').map((e) => ({ ...e, postId: target._id, occurredAt: now, receivedAt: now, userId: null, source: 'client' })),
  )
  const afterNaive = await scoreOf()

  return {
    forgedCount,
    realTopScore: 30 * WEIGHTS.view,
    before,
    adopted: {
      forgedLikes: { accepted: forgedLikes.accepted, rejected: forgedLikes.rejected, ...afterAdoptedLikes },
      forgedImpressions: { accepted: forgedImpressions.accepted, rejected: forgedImpressions.rejected, ...afterAdoptedImpressions },
    },
    naive: { forgedLikesStored: forgedCount, ...afterNaive },
  }
}

async function main() {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-design-'))
  cleanupTasks.push(() => fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
  const mongo = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } })
  cleanupTasks.push(() => mongo.stop())
  const client = new MongoClient(mongo.getUri())
  await client.connect()
  cleanupTasks.push(() => client.close())
  cleanupTasks.push(() => db.close())
  const d = client.db('dv_main')

  const out = {}
  console.log('1. 동시 가입')
  out.signup = await signupRace(d)
  console.log('2. 공감 연타')
  out.like = await likeRace(d)
  console.log('3. 댓글 동시 삭제')
  out.commentDelete = await commentDeleteRace(d)
  console.log('4. 페이지 이동 (글 20만 개 준비 중)')
  out.pagination = await pagination(client)
  console.log('5. 공감·댓글 수 읽기')
  out.denormalization = await denormalization(d)
  console.log('6. 가짜 이벤트')
  out.eventTampering = await eventTampering(mongo.getUri())

  const environment = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    cpu: os.cpus()[0].model.trim(),
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    mongodb: (await client.db('admin').command({ buildInfo: 1 })).version,
  }

  console.log('\n===== 결과')
  console.log(JSON.stringify(out, null, 2))

  const outDir = path.join(__dirname, '..', 'bench-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outName = process.env.BENCH_LABEL ? `design-validation-${process.env.BENCH_LABEL}.json` : 'design-validation.json'
  fs.writeFileSync(path.join(outDir, outName), JSON.stringify({ environment, ...out }, null, 2))
  console.log(`\n결과 저장: bench-results/${outName}`)
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err)
    await cleanup()
    process.exit(1)
  })
