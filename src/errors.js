// 사용자에게 메시지를 보여줘도 되는 에러. 그 외 에러는 에러 처리기에서 내용을 숨김
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
    this.expose = true
  }
}

module.exports = { HttpError }
