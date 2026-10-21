const { getDb } = require('../db')
const { parseObjectId } = require('../utils/objectId')

const SURFACES = new Set(['feed_latest', 'feed_board', 'feed_popular', 'search', 'detail'])

// 브라우저는 노출만 보낼 수 있음. 조회, 공감, 댓글은 조작을 막기 위해 서버가 직접 기록
const CLIENT_TYPES = new Set(['impression'])
const CLIENT_SURFACES = new Set(['feed_latest', 'feed_board', 'feed_popular', 'search'])

const MAX_BATCH = 50
const MAX_POSITION = 200
// 브라우저 시계 오차 허용 범위
const MAX_PAST_MS = 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 5 * 60 * 1000

const events = () => getDb().collection('events')

function normalizeSurface(value) {
  return SURFACES.has(value) ? value : null
}

// 기록이 실패해도 사용자 요청은 성공해야 하므로 에러를 던지지 않음. meta는 종류별 추가 정보(검색어 등)
async function recordServerEvent({ type, userId, postId = null, surface = null, meta }) {
  const now = new Date()
  try {
    await events().insertOne({
      type,
      userId: userId ?? null,
      postId,
      surface,
      position: null,
      occurredAt: now,
      receivedAt: now,
      source: 'server',
      ...(meta ? { meta } : {}),
    })
  } catch (err) {
    console.error(`이벤트 기록 실패 type=${type} postId=${postId}:`, err.message)
  }
}

// 이상한 값이 있으면 그 이벤트만 버림
function parseClientEvent(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  if (!CLIENT_TYPES.has(raw.type)) return null

  const postId = parseObjectId(raw.postId)
  if (!postId) return null

  if (!CLIENT_SURFACES.has(raw.surface)) return null

  if (!Number.isInteger(raw.position) || raw.position < 0 || raw.position >= MAX_POSITION) return null

  const occurredAt = new Date(raw.occurredAt)
  if (Number.isNaN(occurredAt.getTime())) return null
  const age = now - occurredAt
  if (age > MAX_PAST_MS || age < -MAX_FUTURE_MS) return null

  return { type: raw.type, postId, surface: raw.surface, position: raw.position, occurredAt }
}

async function recordClientEvents(userId, rawEvents) {
  const now = new Date()
  const docs = []
  let rejected = 0

  for (const raw of rawEvents) {
    const event = parseClientEvent(raw, now)
    if (!event) {
      rejected++
      continue
    }
    docs.push({ ...event, userId: userId ?? null, receivedAt: now, source: 'client' })
  }

  // 하나가 실패해도 나머지는 저장
  if (docs.length > 0) await events().insertMany(docs, { ordered: false })
  return { accepted: docs.length, rejected }
}

module.exports = { MAX_BATCH, normalizeSurface, recordServerEvent, recordClientEvents }
