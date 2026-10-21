const router = require('express').Router()
const newPosts = require('../realtime/newPosts')
const { isValidBoard } = require('../boards')

// 새 글 알림 SSE. ?board=로 게시판 필터
router.get('/stream/posts', (req, res) => {
  const board = isValidBoard(req.query.board) ? req.query.board : null

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 프록시 버퍼링 끄기
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')

  const client = newPosts.addClient(res, { board, userId: req.user?._id ?? null })
  // 끊긴 연결에 계속 쓰지 않도록 목록에서 제거
  req.on('close', () => newPosts.removeClient(client))
})

module.exports = router
