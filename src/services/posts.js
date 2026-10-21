const { getDb } = require('../db')
const { isValidBoard } = require('../boards')
const { HttpError } = require('../errors')

const PAGE_SIZE = 20

const posts = () => getDb().collection('posts')

function validatePostInput({ board, title, content }) {
  if (!isValidBoard(board)) return '게시판을 선택해 주세요.'
  if (title.length < 1 || title.length > 100) return '제목은 1~100자입니다.'
  if (content.length < 1 || content.length > 5000) return '내용은 1~5000자입니다.'
  return null
}

// 커서 페이지네이션. _id 순서가 곧 작성 순서라 커서보다 작은 _id를 읽음
async function listFeed({ board, cursor, limit = PAGE_SIZE }) {
  const filter = { deletedAt: null }
  if (board) filter.board = board
  if (cursor) filter._id = { $lt: cursor }

  // 한 개 더 읽어 다음 페이지 여부 판단(전체 개수 조회 불필요)
  const docs = await posts().find(filter).sort({ _id: -1 }).limit(limit + 1).toArray()

  const hasNext = docs.length > limit
  const items = hasNext ? docs.slice(0, limit) : docs
  return {
    items,
    nextCursor: hasNext ? items[items.length - 1]._id.toString() : null,
  }
}

async function getPost(id) {
  return posts().findOne({ _id: id, deletedAt: null })
}

async function createPost(user, input, imageUrls) {
  const now = new Date()
  const doc = {
    authorId: user._id,
    // 피드에서 users를 조회하지 않도록 닉네임 복사
    authorNickname: user.nickname,
    board: input.board,
    title: input.title,
    content: input.content,
    imageUrls,
    likeCount: 0,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  const result = await posts().insertOne(doc)
  return result.insertedId
}

async function getOwnPost(id, userId) {
  const post = await getPost(id)
  if (!post) throw new HttpError(404, '글을 찾을 수 없습니다.')
  if (!post.authorId.equals(userId)) throw new HttpError(403, '내가 쓴 글만 수정하거나 삭제할 수 있습니다.')
  return post
}

async function updatePost(id, userId, input) {
  await getOwnPost(id, userId)
  // 확인과 수정 사이에 끼어드는 요청에 대비해 수정 조건에도 작성자를 다시 검
  await posts().updateOne(
    { _id: id, authorId: userId, deletedAt: null },
    { $set: { board: input.board, title: input.title, content: input.content, updatedAt: new Date() } },
  )
}

// 삭제 시각만 기록(soft delete). 이벤트가 글 id를 가리키고 있어 문서를 지우지 않음
async function deletePost(id, userId) {
  await getOwnPost(id, userId)
  await posts().updateOne(
    { _id: id, authorId: userId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  )
}

module.exports = {
  PAGE_SIZE,
  validatePostInput,
  listFeed,
  getPost,
  getOwnPost,
  createPost,
  updatePost,
  deletePost,
}
