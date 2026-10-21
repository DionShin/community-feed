const { getDb } = require('../db')

// 서버당 Change Stream 하나를 열어 연결된 브라우저에 나눠 보냄
// 브라우저마다 열면 접속자 수만큼 DB 감시 커서가 생김

const HEARTBEAT_MS = 25 * 1000
const RETRY_MS = 3000

// { res, board, userId }
const clients = new Set()

let stream = null
let resumeToken = null
let running = false
let retryTimer = null
let heartbeatTimer = null

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function addClient(res, { board = null, userId = null } = {}) {
  const client = { res, board, userId }
  clients.add(client)
  return client
}

function removeClient(client) {
  clients.delete(client)
}

function clientCount() {
  return clients.size
}

function broadcast(post) {
  // 글 내용은 보내지 않음(브라우저는 개수만 세고 새로고침)
  const data = { postId: String(post._id), board: post.board }
  for (const client of clients) {
    if (client.board && client.board !== post.board) continue
    if (client.userId && post.authorId?.equals(client.userId)) continue
    send(client.res, 'new-post', data)
  }
}

// resumeToken이 있으면 이어받아 끊긴 동안의 글도 전달(oplog 보관 범위 안에서만)
// 처음 열 때는 DB 현재 시각부터 받아 감시 시작 전 공백을 없앰
async function openStream() {
  const pipeline = [{ $match: { operationType: 'insert' } }]
  let options
  if (resumeToken) {
    options = { resumeAfter: resumeToken }
  } else {
    try {
      const { operationTime } = await getDb().command({ ping: 1 })
      options = operationTime ? { startAtOperationTime: operationTime } : {}
    } catch {
      options = {}
    }
  }

  const current = getDb().collection('posts').watch(pipeline, options)
  stream = current

  current.on('change', (change) => {
    resumeToken = change._id
    broadcast(change.fullDocument)
  })

  current.on('error', (err) => {
    if (stream === current) stream = null
    current.close().catch(() => {})

    // 40573: 단독 서버라 Change Stream 불가. 재시도해도 소용없어 알림을 끔
    if (err.code === 40573) {
      console.warn('이 DB는 Change Stream을 지원하지 않아 새 글 알림을 끕니다.')
      running = false
      return
    }
    // 286: 이어받을 위치가 oplog 범위를 벗어남. 지금부터 다시 들음
    if (err.code === 286) resumeToken = null

    console.error('새 글 알림 스트림 오류, 잠시 후 다시 연결합니다:', err.message)
    if (running) retryTimer = setTimeout(() => openStream().catch(() => {}), RETRY_MS)
  })
}

async function closeStream() {
  const current = stream
  stream = null
  if (current) await current.close()
}

async function start() {
  running = true
  // 프록시가 조용한 연결을 끊지 않도록 주기적으로 핑
  heartbeatTimer = setInterval(() => {
    for (const client of clients) client.res.write(': ping\n\n')
  }, HEARTBEAT_MS)
  await openStream()
}

// SSE 연결을 직접 닫지 않으면 서버 종료가 끝나지 않음
async function stop() {
  running = false
  clearTimeout(retryTimer)
  clearInterval(heartbeatTimer)
  for (const client of clients) client.res.end()
  clients.clear()
  await closeStream()
}

module.exports = { addClient, removeClient, clientCount, start, stop, openStream, closeStream }
