const router = require('express').Router()
const eventService = require('../services/events')
const { HttpError } = require('../errors')

// 브라우저가 모아 보내는 노출 이벤트. 피드는 비로그인도 볼 수 있어 비로그인 노출도 받음
router.post('/api/events', async (req, res) => {
  const list = req.body?.events
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, 'events 배열이 필요합니다.')
  }
  if (list.length > eventService.MAX_BATCH) {
    throw new HttpError(400, `한 번에 최대 ${eventService.MAX_BATCH}개까지 보낼 수 있습니다.`)
  }

  const result = await eventService.recordClientEvents(req.user?._id, list)
  // 일부는 검사에서 버려질 수 있어 202로 응답
  res.status(202).json(result)
})

module.exports = router
