export { nativeQuestionReplyDisplayText, parseNativeQuestionReply, type NativeQuestionReply } from '@hapi/protocol'

export function isNativeAsyncQuestionRequest(requestId: string): boolean {
    return requestId.startsWith('native-async:')
}
