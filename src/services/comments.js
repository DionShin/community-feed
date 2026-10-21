const { getDb } = require('../db')
const { getPost } = require('./posts')
const { HttpError } = require('../errors')

const comments = () => getDb().collection('comments')
const posts = () => getDb().collection('posts')

function validateComment(content) {
  if (content.length < 1 || content.length > 1000) return '댓글은 1~1000자입니다.'
  return null
}

// 페이지 나누기 없이 전부 읽음
async function listComments(postId) {
  return comments().find({ postId, deletedAt: null }).sort({ _id: 1 }).toArray()
}

async function addComment(postId, user, content) {
  const post = await getPost(postId)
  if (!post) throw new HttpError(404, '글을 찾을 수 없습니다.')

  await comments().insertOne({
    postId,
    authorId: user._id,
    authorNickname: user.nickname,
    content,
    createdAt: new Date(),
  })
  // 피드에서 매번 세지 않도록 글 문서에 숫자를 둠. 두 쓰기 사이에 실패하면 어긋날 수 있음(품질 검사로 탐지)
  await posts().updateOne({ _id: postId }, { $inc: { commentCount: 1 } })
}

async function deleteComment(commentId, userId) {
  const comment = await comments().findOne({ _id: commentId, deletedAt: null })
  if (!comment) throw new HttpError(404, '댓글을 찾을 수 없습니다.')
  if (!comment.authorId.equals(userId)) throw new HttpError(403, '내가 쓴 댓글만 삭제할 수 있습니다.')

  const result = await comments().updateOne(
    { _id: commentId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  )
  // 동시 삭제 요청이어도 실제로 바뀐 요청만 숫자를 내림
  const changed = result.modifiedCount === 1
  if (changed) {
    await posts().updateOne({ _id: comment.postId }, { $inc: { commentCount: -1 } })
  }
  return { postId: comment.postId, changed }
}

module.exports = { validateComment, listComments, addComment, deleteComment }
