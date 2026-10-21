// 측정용 테스트 데이터 생성(실제 서비스 DB에는 쓰지 않음)
// 1. 쏠림: 글 인기도와 유저 활동량을 지프 분포(1 / r^s)로 생성
// 2. 퍼널: 노출 > 조회 > 공감, 댓글
const { ObjectId } = require('mongodb')
const { BOARDS } = require('../src/boards')

const DAY = 24 * 60 * 60 * 1000

const EVENT_MIX = [
  ['impression', 0.7],
  ['view', 0.22],
  ['like', 0.045],
  ['unlike', 0.005],
  ['comment', 0.03],
]

// 매번 같은 데이터로 비교하기 위해 시드 고정 난수 사용
function createRandom(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 누적 확률표 + 이진 탐색
function createZipfSampler(n, s, random) {
  const cumulative = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    total += 1 / Math.pow(i + 1, s)
    cumulative[i] = total
  }
  return () => {
    const target = random() * total
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cumulative[mid] < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

// 피드가 _id 순서로 최신순을 정하므로 작성 시각에 맞는 ObjectId 생성
function objectIdAt(ms, random) {
  let hex = Math.floor(ms / 1000).toString(16).padStart(8, '0')
  for (let i = 0; i < 16; i++) hex += Math.floor(random() * 16).toString(16)
  return new ObjectId(hex)
}

function pickType(random) {
  let r = random()
  for (const [type, p] of EVENT_MIX) {
    if (r < p) return type
    r -= p
  }
  return 'impression'
}

async function insertInBatches(collection, total, makeDoc, batchSize = 10000) {
  for (let start = 0; start < total; start += batchSize) {
    const docs = []
    for (let i = start; i < Math.min(start + batchSize, total); i++) docs.push(makeDoc(i))
    await collection.insertMany(docs, { ordered: false })
  }
}

async function seed(db, { users = 5000, posts = 20000, events = 1000000, days = 7, now = new Date(), seedValue = 42 } = {}) {
  const random = createRandom(seedValue)
  const start = now.getTime() - days * DAY

  await db.dropDatabase()

  const userIds = Array.from({ length: users }, () => new ObjectId())
  await insertInBatches(db.collection('users'), users, (i) => ({
    _id: userIds[i],
    username: `user${i}`,
    passwordHash: 'not-a-real-hash',
    nickname: `유저${i}`,
    createdAt: new Date(start - DAY),
  }))

  const postIds = []
  const postCreatedAt = []
  for (let i = 0; i < posts; i++) {
    const createdAt = start + random() * days * DAY
    postCreatedAt.push(createdAt)
    postIds.push(objectIdAt(createdAt, random))
  }
  await insertInBatches(db.collection('posts'), posts, (i) => {
    const author = Math.floor(random() * users)
    return {
      _id: postIds[i],
      authorId: userIds[author],
      authorNickname: `유저${author}`,
      board: BOARDS[Math.floor(random() * BOARDS.length)].id,
      title: `테스트 글 ${i}`,
      content: '측정용으로 만든 글입니다. '.repeat(5),
      imageUrls: [],
      likeCount: 0,
      commentCount: 0,
      createdAt: new Date(postCreatedAt[i]),
      updatedAt: new Date(postCreatedAt[i]),
    }
  })

  // 최신 글만 인기글이 되지 않도록 인기 순위를 섞음
  const popularityOrder = Array.from({ length: posts }, (_, i) => i)
  for (let i = posts - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[popularityOrder[i], popularityOrder[j]] = [popularityOrder[j], popularityOrder[i]]
  }
  const pickPost = createZipfSampler(posts, 1.1, random)
  const pickUser = createZipfSampler(users, 0.8, random)

  await insertInBatches(db.collection('events'), events, () => {
    const p = popularityOrder[pickPost()]
    const at = new Date(postCreatedAt[p] + random() * (now.getTime() - postCreatedAt[p]))
    const type = pickType(random)
    const anonymous = (type === 'impression' || type === 'view') && random() < 0.1
    const client = type === 'impression'
    return {
      type,
      userId: anonymous ? null : userIds[pickUser()],
      postId: postIds[p],
      surface: client ? 'feed_latest' : 'detail',
      position: client ? Math.floor(random() * 20) : null,
      occurredAt: at,
      receivedAt: at,
      source: client ? 'client' : 'server',
    }
  })

  return { users, posts, events, days, now }
}

module.exports = { seed }
