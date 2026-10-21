const { getDb } = require('../db')
const { getPost } = require('./posts')
const { HttpError } = require('../errors')

const likes = () => getDb().collection('likes')
const posts = () => getDb().collection('posts')

async function ensurePost(postId) {
  const post = await getPost(postId)
  if (!post) throw new HttpError(404, '글을 찾을 수 없습니다.')
}

async function isLiked(postId, userId) {
  return Boolean(await likes().findOne({ postId, userId }))
}

async function status(postId, userId) {
  const [post, liked] = await Promise.all([
    posts().findOne({ _id: postId }, { projection: { likeCount: 1 } }),
    isLiked(postId, userId),
  ])
  return { liked, likeCount: post.likeCount }
}

// 중복은 (postId, userId) 고유 인덱스로 막음. 이미 공감한 상태면 에러 없이 현재 상태를 돌려줌
// changed: 상태가 실제로 바뀌었는지(이벤트 기록 여부 판단용)
async function like(postId, userId) {
  await ensurePost(postId)
  let changed = false
  try {
    await likes().insertOne({ postId, userId, createdAt: new Date() })
    changed = true
    // 실제로 새로 생긴 경우에만 증가
    await posts().updateOne({ _id: postId }, { $inc: { likeCount: 1 } })
  } catch (err) {
    if (err.code !== 11000) throw err
  }
  return { ...(await status(postId, userId)), changed }
}

async function unlike(postId, userId) {
  await ensurePost(postId)
  const result = await likes().deleteOne({ postId, userId })
  const changed = result.deletedCount === 1
  // 실제로 지운 경우에만 감소(음수 방지)
  if (changed) {
    await posts().updateOne({ _id: postId }, { $inc: { likeCount: -1 } })
  }
  return { ...(await status(postId, userId)), changed }
}

module.exports = { isLiked, like, unlike }
