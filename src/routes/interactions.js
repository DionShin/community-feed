const router = require('express').Router()
const requireLogin = require('../middlewares/requireLogin')
const commentService = require('../services/comments')
const likeService = require('../services/likes')
const eventService = require('../services/events')
const { parseObjectId } = require('../utils/objectId')
const { HttpError } = require('../errors')

function idParam(req, notFoundMessage) {
  const id = parseObjectId(req.params.id)
  if (!id) throw new HttpError(404, notFoundMessage)
  return id
}

router.post('/posts/:id/comments', requireLogin, async (req, res) => {
  const postId = idParam(req, '글을 찾을 수 없습니다.')
  const content = String(req.body.content ?? '').trim()

  const error = commentService.validateComment(content)
  if (error) throw new HttpError(400, error)

  await commentService.addComment(postId, req.user, content)
  await eventService.recordServerEvent({ type: 'comment', userId: req.user._id, postId, surface: 'detail' })
  res.redirect(`/posts/${postId}#comments`)
})

router.delete('/comments/:id', requireLogin, async (req, res) => {
  const { postId, changed } = await commentService.deleteComment(idParam(req, '댓글을 찾을 수 없습니다.'), req.user._id)
  // 실제로 지워졌을 때만 기록. 품질 검사가 확인 대상 글을 고를 때 씀
  if (changed) {
    await eventService.recordServerEvent({ type: 'comment_delete', userId: req.user._id, postId, surface: 'detail' })
  }
  res.redirect(`/posts/${postId}#comments`)
})

// 토글 대신 PUT(공감 상태로), DELETE(공감 안 한 상태로)로 나눠 여러 번 보내도 결과가 같게 함
// 상태가 바뀐 경우에만 이벤트 기록. 이벤트 수와 실제 공감 수의 기준을 맞추기 위함
async function respondLike(req, res, action, type) {
  const postId = idParam(req, '글을 찾을 수 없습니다.')
  const { changed, ...body } = await action(postId, req.user._id)
  if (changed) {
    await eventService.recordServerEvent({ type, userId: req.user._id, postId, surface: 'detail' })
  }
  res.json(body)
}

router.put('/posts/:id/like', requireLogin, (req, res) => respondLike(req, res, likeService.like, 'like'))
router.delete('/posts/:id/like', requireLogin, (req, res) => respondLike(req, res, likeService.unlike, 'unlike'))

module.exports = router
