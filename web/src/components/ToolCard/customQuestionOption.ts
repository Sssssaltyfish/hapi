const customLabels = new Set([
    'other', 'none of the above', 'write my own answer', 'write your own answer', 'type your own answer',
    '其他', '其它', '以上都不是', '自己填写', '输入您自己的答案',
    'другое', 'ничего из вышеперечисленного', 'введите свой ответ'
])

export function isCustomQuestionOption(option: { label: string; isOther?: boolean }): boolean {
    return option.isOther === true || customLabels.has(option.label.toLowerCase())
}
