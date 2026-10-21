require('dotenv').config({ quiet: true })

// 필수 값이 없으면 시작 단계에서 바로 실패시킴. 실행 중에 엉뚱한 곳에서 터지는 것을 막기 위함
function required(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`환경변수 ${name}가 설정되지 않았습니다. .env.example을 참고하세요.`)
  }
  return value
}

// 이미지 업로드는 선택 기능. S3_BUCKET이 없으면 업로드 없이 동작함
function loadS3() {
  if (!process.env.S3_BUCKET) return null
  return {
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || 'ap-northeast-2',
    accessKeyId: required('S3_KEY'),
    secretAccessKey: required('S3_SECRET'),
  }
}

module.exports = {
  port: Number(process.env.PORT) || 8080,
  mongoUrl: required('MONGO_URL'),
  dbName: process.env.DB_NAME || 'community',
  sessionSecret: required('SESSION_SECRET'),
  s3: loadS3(),
  // atlas: Atlas Search(운영), basic: 정규식 검색(테스트, Atlas가 아닌 환경)
  searchMode: process.env.SEARCH_MODE === 'basic' ? 'basic' : 'atlas',
}
