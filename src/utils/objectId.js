const { ObjectId } = require('mongodb')

// 형식이 틀리면 null. new ObjectId는 잘못된 값에 예외를 던져 500이 나므로 먼저 검사함
// ObjectId.isValid는 12글자 문자열도 통과시켜서 24자리 16진수를 직접 확인
function parseObjectId(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) return null
  return new ObjectId(value)
}

module.exports = { parseObjectId }
