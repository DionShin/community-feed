// Atlas Search 인덱스 생성 또는 갱신(Atlas 전용)
// 사용법: npm run search:index
const config = require('../src/config')
const db = require('../src/db')
const { SEARCH_INDEX } = require('../src/services/search')

// 제목과 내용만 색인. 한국어 분석기로 조사와 어미를 처리
const definition = {
  mappings: {
    dynamic: false,
    fields: {
      title: { type: 'string', analyzer: 'lucene.korean' },
      content: { type: 'string', analyzer: 'lucene.korean' },
    },
  },
}

async function listIndexes(collection) {
  return collection.aggregate([{ $listSearchIndexes: { name: SEARCH_INDEX } }]).toArray()
}

async function main() {
  await db.connect(config.mongoUrl, config.dbName)
  const d = db.getDb()
  const posts = d.collection('posts')

  const existing = await listIndexes(posts)
  if (existing.length === 0) {
    await d.command({ createSearchIndexes: 'posts', indexes: [{ name: SEARCH_INDEX, definition }] })
    console.log(`검색 인덱스 ${SEARCH_INDEX} 생성을 요청했습니다.`)
  } else {
    await d.command({ updateSearchIndex: 'posts', name: SEARCH_INDEX, definition })
    console.log(`검색 인덱스 ${SEARCH_INDEX} 정의 갱신을 요청했습니다.`)
  }

  // 비동기로 만들어지므로 검색 가능해질 때까지 대기
  const deadline = Date.now() + 3 * 60 * 1000
  while (Date.now() < deadline) {
    const [index] = await listIndexes(posts)
    if (index?.queryable && index.status === 'READY') {
      console.log('검색 인덱스가 준비되었습니다.')
      await db.close()
      return
    }
    console.log(`준비 중... 상태: ${index?.status ?? '확인 중'}`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  console.log('3분 안에 준비되지 않았습니다. Atlas 화면의 Search 탭에서 상태를 확인하세요.')
  await db.close()
}

main().catch(async (err) => {
  console.error('검색 인덱스 작업 실패:', err.message)
  await db.close()
  process.exit(1)
})
