const http = require('http')
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server')

// 테스트 파일마다 인메모리 MongoDB와 앱 서버를 새로 띄움(파일별 별도 프로세스라 데이터가 섞이지 않음)
// Change Stream이 필요한 테스트는 replSet: true로 노드 하나짜리 레플리카 셋 사용
async function startTestApp({ replSet = false } = {}) {
  const mongo = replSet
    ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    : await MongoMemoryServer.create()
  process.env.MONGO_URL = mongo.getUri()
  process.env.SESSION_SECRET = 'test-secret'
  process.env.DB_NAME = 'community_test'
  delete process.env.S3_BUCKET
  // 인메모리 MongoDB에는 Atlas Search가 없어 정규식 검색으로 테스트
  process.env.SEARCH_MODE = 'basic'

  // config가 테스트용 값을 읽도록 환경변수 설정 후에 앱 모듈을 불러옴
  const db = require('../src/db')
  const { createApp } = require('../src/app')
  const { attachChat } = require('../src/realtime/chat')
  await db.connect(process.env.MONGO_URL, process.env.DB_NAME)
  await db.ensureIndexes()

  const server = http.createServer(createApp())
  const io = attachChat(server)
  await new Promise((resolve) => server.listen(0, resolve))
  const baseUrl = `http://localhost:${server.address().port}`

  async function close() {
    // fetch가 유지 중인 연결이 있으면 종료가 끝나지 않아 강제로 끊음
    io.close()
    server.closeAllConnections()
    await db.close()
    await mongo.stop()
  }

  return { baseUrl, db, close }
}

function form(data, cookie) {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(data),
  }
}

function sessionCookie(res) {
  const raw = res.headers.get('set-cookie')
  return raw ? raw.split(';')[0] : null
}

// 가입 후 로그인된 세션 쿠키 반환
async function signup(baseUrl, username, nickname = username) {
  const res = await fetch(`${baseUrl}/register`, form({ username, password: 'password123', nickname }))
  if (res.status !== 302) throw new Error(`가입 실패: ${res.status}`)
  return sessionCookie(res)
}

module.exports = { startTestApp, form, sessionCookie, signup }
