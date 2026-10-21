const config = require('../config')
const { getDb } = require('../db')

const SEARCH_INDEX = 'posts_search'
const MAX_RESULTS = 20
const MAX_QUERY_LENGTH = 50

const posts = () => getDb().collection('posts')

function normalizeQuery(raw) {
  return String(raw ?? '').trim().slice(0, MAX_QUERY_LENGTH)
}

// 관련도 순. 제목 일치에 가중치 3배
async function searchWithAtlas(query) {
  return posts()
    .aggregate([
      {
        $search: {
          index: SEARCH_INDEX,
          compound: {
            should: [
              { text: { query, path: 'title', score: { boost: { value: 3 } } } },
              { text: { query, path: 'content' } },
            ],
            minimumShouldMatch: 1,
          },
        },
      },
      // 삭제된 글은 검색 인덱스에 남아 있어 결과에서 거름
      { $match: { deletedAt: null } },
      { $limit: MAX_RESULTS },
      { $addFields: { searchScore: { $meta: 'searchScore' } } },
    ])
    .toArray()
}

// Atlas Search가 없는 환경(테스트)용. 인덱스를 못 써서 데이터가 많으면 느림
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function searchWithRegex(query) {
  const pattern = new RegExp(escapeRegex(query), 'i')
  return posts()
    .find({ deletedAt: null, $or: [{ title: pattern }, { content: pattern }] })
    .sort({ _id: -1 })
    .limit(MAX_RESULTS)
    .toArray()
}

async function searchPosts(rawQuery) {
  const query = normalizeQuery(rawQuery)
  if (!query) return { query, posts: [] }
  const found = config.searchMode === 'atlas' ? await searchWithAtlas(query) : await searchWithRegex(query)
  return { query, posts: found }
}

module.exports = { SEARCH_INDEX, MAX_RESULTS, searchPosts }
