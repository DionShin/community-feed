const router = require('express').Router()
const requireLogin = require('../middlewares/requireLogin')
const { uploadPostImages, uploadEnabled } = require('../middlewares/upload')
const postService = require('../services/posts')
const commentService = require('../services/comments')
const likeService = require('../services/likes')
const eventService = require('../services/events')
const popularService = require('../services/popular')
const searchService = require('../services/search')
const { BOARDS, isValidBoard } = require('../boards')
const { parseObjectId } = require('../utils/objectId')
const { HttpError } = require('../errors')

function readPostInput(body) {
  return {
    board: String(body.board ?? ''),
    title: String(body.title ?? '').trim(),
    content: String(body.content ?? '').trim(),
  }
}

function postIdFrom(req) {
  const id = parseObjectId(req.params.id)
  if (!id) throw new HttpError(404, '글을 찾을 수 없습니다.')
  return id
}

// ?board=게시판, ?cursor=다음 페이지 시작점
router.get('/', async (req, res) => {
  const board = req.query.board ? String(req.query.board) : null
  if (board && !isValidBoard(board)) throw new HttpError(404, '없는 게시판입니다.')

  let cursor = null
  if (req.query.cursor) {
    cursor = parseObjectId(String(req.query.cursor))
    if (!cursor) throw new HttpError(400, '잘못된 페이지 주소입니다.')
  }

  const { items, nextCursor } = await postService.listFeed({ board, cursor })
  res.render('index', {
    boards: BOARDS,
    currentBoard: board,
    posts: items,
    nextCursor,
    surface: board ? 'feed_board' : 'feed_latest',
  })
})

// 순위가 계속 바뀌어 페이지 이동 없이 상위 20개만 보여줌
router.get('/popular', async (req, res) => {
  const posts = await popularService.getPopularPostsCached()
  res.render('index', {
    boards: BOARDS,
    currentBoard: null,
    posts,
    nextCursor: null,
    surface: 'feed_popular',
    windowHours: popularService.WINDOW_HOURS,
  })
})

router.get('/search', async (req, res) => {
  const { query, posts } = await searchService.searchPosts(req.query.q)

  // 결과 0건 검색어를 파악하기 위해 검색어와 결과 수를 기록
  if (query) {
    await eventService.recordServerEvent({
      type: 'search',
      userId: req.user?._id,
      surface: 'search',
      meta: { query, resultCount: posts.length },
    })
  }

  res.render('index', {
    boards: BOARDS,
    currentBoard: null,
    posts,
    nextCursor: null,
    surface: 'search',
    query,
  })
})

router.get('/posts/new', requireLogin, (req, res) => {
  res.render('post-new', { boards: BOARDS, uploadEnabled, error: null, input: {} })
})

router.post('/posts', requireLogin, uploadPostImages, async (req, res) => {
  const input = readPostInput(req.body)
  const error = postService.validatePostInput(input)
  if (error) {
    return res.status(400).render('post-new', { boards: BOARDS, uploadEnabled, error, input })
  }

  const imageUrls = (req.files ?? []).map((f) => f.location)
  const id = await postService.createPost(req.user, input, imageUrls)
  res.redirect(`/posts/${id}`)
})

router.get('/posts/:id', async (req, res) => {
  const id = postIdFrom(req)
  const post = await postService.getPost(id)
  if (!post) throw new HttpError(404, '글을 찾을 수 없습니다.')

  const [comments, liked] = await Promise.all([
    commentService.listComments(id),
    req.user ? likeService.isLiked(id, req.user._id) : false,
  ])

  // 화면별 클릭률을 계산할 수 있도록 출발 화면(?from=)을 함께 기록
  await eventService.recordServerEvent({
    type: 'view',
    userId: req.user?._id,
    postId: id,
    surface: eventService.normalizeSurface(req.query.from),
  })

  const isAuthor = Boolean(req.user && post.authorId.equals(req.user._id))
  res.render('post-detail', { post, isAuthor, comments, liked })
})

router.get('/posts/:id/edit', requireLogin, async (req, res) => {
  const post = await postService.getOwnPost(postIdFrom(req), req.user._id)
  res.render('post-edit', { boards: BOARDS, post, error: null })
})

router.patch('/posts/:id', requireLogin, async (req, res) => {
  const id = postIdFrom(req)
  const input = readPostInput(req.body)
  const error = postService.validatePostInput(input)
  if (error) {
    const post = await postService.getOwnPost(id, req.user._id)
    return res.status(400).render('post-edit', { boards: BOARDS, post: { ...post, ...input }, error })
  }

  await postService.updatePost(id, req.user._id, input)
  res.redirect(`/posts/${id}`)
})

router.delete('/posts/:id', requireLogin, async (req, res) => {
  await postService.deletePost(postIdFrom(req), req.user._id)
  res.redirect('/')
})

module.exports = router
