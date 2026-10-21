const { Server } = require('socket.io')
const passport = require('passport')
const { sessionMiddleware } = require('../session')
const chatService = require('../services/chat')
const { parseObjectId } = require('../utils/objectId')

// handshake 요청에만 세션과 로그인 확인 적용
function onlyForHandshake(middleware) {
  return (req, res, next) => {
    const isHandshake = req._query.sid === undefined
    if (isHandshake) middleware(req, res, next)
    else next()
  }
}

function attachChat(httpServer) {
  const io = new Server(httpServer)

  io.engine.use(onlyForHandshake(sessionMiddleware))
  io.engine.use(onlyForHandshake(passport.session()))
  io.engine.use(
    onlyForHandshake((req, res, next) => {
      if (req.user) return next()
      res.writeHead(401)
      res.end()
    }),
  )

  io.on('connection', (socket) => {
    const user = socket.request.user

    // 방 id만으로 들어올 수 없도록 입장마다 참여자 확인
    socket.on('join', async ({ roomId } = {}, ack = () => {}) => {
      try {
        const id = parseObjectId(roomId)
        const room = id && (await chatService.getRoomForMember(id, user._id).catch(() => null))
        if (!room) return ack({ ok: false, error: '채팅방에 들어갈 수 없습니다.' })
        socket.join(String(room._id))
        ack({ ok: true })
      } catch (err) {
        console.error('채팅방 입장 실패:', err.message)
        ack({ ok: false, error: '잠시 후 다시 시도해 주세요.' })
      }
    })

    socket.on('message', async ({ roomId, content } = {}, ack = () => {}) => {
      try {
        if (!socket.rooms.has(String(roomId))) return ack({ ok: false, error: '먼저 채팅방에 들어가야 합니다.' })

        const error = chatService.validateMessage(content)
        if (error) return ack({ ok: false, error })

        const room = await chatService.getRoomForMember(parseObjectId(String(roomId)), user._id)
        const saved = await chatService.saveMessage(room, user, content)

        const payload = {
          id: String(saved._id),
          senderId: String(saved.senderId),
          senderNickname: saved.senderNickname,
          content: saved.content,
          createdAt: saved.createdAt.toISOString(),
        }
        // 저장이 끝난 메시지만 방 전체에 전달
        io.to(String(room._id)).emit('message', payload)
        ack({ ok: true, message: payload })
      } catch (err) {
        console.error('메시지 전송 실패:', err.message)
        ack({ ok: false, error: '메시지를 보내지 못했습니다.' })
      }
    })
  })

  return io
}

module.exports = { attachChat }
