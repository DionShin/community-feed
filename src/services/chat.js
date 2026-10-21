const { getDb } = require('../db')
const { getPost } = require('./posts')
const { HttpError } = require('../errors')

const HISTORY_SIZE = 50
const MAX_MESSAGE_LENGTH = 1000

const rooms = () => getDb().collection('chatRooms')
const messages = () => getDb().collection('chatMessages')

// (글, 문의자)당 방 하나(고유 인덱스). created는 이벤트 기록 여부 판단용
async function openRoom(postId, requester) {
  const post = await getPost(postId)
  if (!post) throw new HttpError(404, '글을 찾을 수 없습니다.')
  if (post.authorId.equals(requester._id)) throw new HttpError(400, '내 글에는 문의할 수 없습니다.')

  const now = new Date()
  const filter = { postId, requesterId: requester._id }
  const insertFields = {
    postId,
    requesterId: requester._id,
    authorId: post.authorId,
    members: [post.authorId, requester._id],
    postTitle: post.title,
    lastMessage: null,
    lastMessageAt: now,
    createdAt: now,
  }

  try {
    const result = await rooms().findOneAndUpdate(
      filter,
      { $setOnInsert: insertFields },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    )
    return { room: result.value, created: !result.lastErrorObject?.updatedExisting }
  } catch (err) {
    // 동시 요청이면 한쪽 upsert가 고유 인덱스에 걸림. 먼저 만들어진 방을 돌려줌
    if (err.code !== 11000) throw err
    return { room: await rooms().findOne(filter), created: false }
  }
}

function isMember(room, userId) {
  return room.members.some((m) => m.equals(userId))
}

async function getRoomForMember(roomId, userId) {
  const room = await rooms().findOne({ _id: roomId })
  if (!room) throw new HttpError(404, '채팅방을 찾을 수 없습니다.')
  if (!isMember(room, userId)) throw new HttpError(403, '참여한 채팅방만 볼 수 있습니다.')
  return room
}

async function listRooms(userId) {
  return rooms().find({ members: userId }).sort({ lastMessageAt: -1 }).limit(50).toArray()
}

// 최근 50개만 보여줌. 이전 메시지 보기는 미구현
async function recentMessages(roomId) {
  const latest = await messages().find({ roomId }).sort({ _id: -1 }).limit(HISTORY_SIZE).toArray()
  return latest.reverse()
}

function validateMessage(content) {
  if (typeof content !== 'string') return '메시지 형식이 올바르지 않습니다.'
  const trimmed = content.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_MESSAGE_LENGTH) return `메시지는 1~${MAX_MESSAGE_LENGTH}자입니다.`
  return null
}

async function saveMessage(room, sender, content) {
  const doc = {
    roomId: room._id,
    senderId: sender._id,
    senderNickname: sender.nickname,
    content: content.trim(),
    createdAt: new Date(),
  }
  const { insertedId } = await messages().insertOne(doc)
  // 목록에서 방마다 마지막 메시지를 조회하지 않도록 방 문서에 복사
  await rooms().updateOne(
    { _id: room._id },
    { $set: { lastMessage: doc.content.slice(0, 100), lastMessageAt: doc.createdAt } },
  )
  return { ...doc, _id: insertedId }
}

module.exports = {
  openRoom,
  isMember,
  getRoomForMember,
  listRooms,
  recentMessages,
  validateMessage,
  saveMessage,
}
