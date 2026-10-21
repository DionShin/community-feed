const router = require('express').Router()
const requireLogin = require('../middlewares/requireLogin')
const chatService = require('../services/chat')
const eventService = require('../services/events')
const { parseObjectId } = require('../utils/objectId')
const { HttpError } = require('../errors')

function idParam(req, message) {
  const id = parseObjectId(req.params.id)
  if (!id) throw new HttpError(404, message)
  return id
}

// 이미 방이 있으면 그 방으로 이동
router.post('/posts/:id/chat', requireLogin, async (req, res) => {
  const postId = idParam(req, '글을 찾을 수 없습니다.')
  const { room, created } = await chatService.openRoom(postId, req.user)

  // 방이 처음 만들어질 때만 기록
  if (created) {
    await eventService.recordServerEvent({ type: 'chat_request', userId: req.user._id, postId, surface: 'detail' })
  }
  res.redirect(`/chats/${room._id}`)
})

router.get('/chats', requireLogin, async (req, res) => {
  const rooms = await chatService.listRooms(req.user._id)
  res.render('chat-list', { rooms })
})

router.get('/chats/:id', requireLogin, async (req, res) => {
  const room = await chatService.getRoomForMember(idParam(req, '채팅방을 찾을 수 없습니다.'), req.user._id)
  const messages = await chatService.recentMessages(room._id)
  res.render('chat-room', { room, messages })
})

module.exports = router
