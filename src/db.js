const { MongoClient } = require('mongodb')

let client
let db

async function connect(url, dbName) {
  client = new MongoClient(url)
  await client.connect()
  db = client.db(dbName)
  return db
}

function getDb() {
  if (!db) throw new Error('DB가 아직 연결되지 않았습니다.')
  return db
}

// 서버 시작 시 실행. createIndex는 이미 있으면 아무것도 하지 않아 반복 실행해도 안전함
async function ensureIndexes() {
  const d = getDb()
  await Promise.all([
    d.collection('users').createIndex({ username: 1 }, { unique: true }),

    d.collection('posts').createIndex({ board: 1, _id: -1 }),
    d.collection('posts').createIndex({ authorId: 1, _id: -1 }),

    d.collection('comments').createIndex({ postId: 1, _id: 1 }),

    d.collection('likes').createIndex({ postId: 1, userId: 1 }, { unique: true }),

    d.collection('chatRooms').createIndex({ postId: 1, requesterId: 1 }, { unique: true }),
    d.collection('chatRooms').createIndex({ members: 1, lastMessageAt: -1 }),

    d.collection('chatMessages').createIndex({ roomId: 1, _id: -1 }),

    // 집계용 커버링 인덱스. type(같음)을 receivedAt(범위)보다 앞에 둬야 노출 이벤트 키를 건너뜀
    // 측정 결과는 docs/problem-solving.md 1번
    d.collection('events').createIndex({ type: 1, receivedAt: 1, postId: 1 }),

    // _id가 { postId, hour }라 고유 인덱스는 따로 필요 없음
    d.collection('post_stats_hourly').createIndex({ hour: 1 }),

    // 품질 검사 결과는 30일 후 자동 삭제(TTL)
    d.collection('dq_reports').createIndex({ runAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }),
  ])

  // 위 커버링 인덱스로 대체된 이전 인덱스. 남겨 두면 저장 비용만 늘어남
  await dropIndexIfExists(d.collection('events'), 'receivedAt_1')
}

async function dropIndexIfExists(collection, name) {
  try {
    await collection.dropIndex(name)
  } catch (err) {
    // 27: 인덱스 없음, 26: 컬렉션 없음. 이미 정리된 상태라 무시
    if (err.code !== 27 && err.code !== 26) throw err
  }
}

async function close() {
  if (client) await client.close()
}

module.exports = { connect, getDb, ensureIndexes, close }
