import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import {
    isRequestUserInputToolName,
    parseRequestUserInputInput,
    formatRequestUserInputAnswers,
    isRequestUserInputQuestionAnswered,
    isRequestUserInputUrlConfirmed,
    openRequestUserInputUrl,
    requestUserInputOptions,
    selectRequestUserInputOption,
    type RequestUserInputOption,
    type RequestUserInputQuestion,
    type RequestUserInputQuestionAnswer
} from '@/components/ToolCard/requestUserInput'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'
import { isNativeAsyncQuestionRequest } from '@/lib/nativeQuestionReply'
import { DismissQuestionButton, QuestionAnswerInput } from './questionControls'

function SelectionMark(props: { checked: boolean }) {
    const mark = props.checked ? '●' : '○'
    return (
        <span className="mt-0.5 w-4 shrink-0 text-center text-[var(--app-hint)]">
            {mark}
        </span>
    )
}

function OptionRow(props: {
    checked: boolean
    disabled: boolean
    title: string
    description?: string | null
    onClick: () => void
}) {
    return (
        <button
            type="button"
            className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] disabled:pointer-events-none disabled:opacity-50',
                props.checked ? 'bg-[var(--app-subtle-bg)]' : null
            )}
            disabled={props.disabled}
            aria-pressed={props.checked}
            onClick={props.onClick}
        >
            <SelectionMark checked={props.checked} />
            <span className="min-w-0 flex-1">
                <div className="[&_.aui-md]:font-medium [&_.aui-md]:text-sm [&_.aui-md]:text-[var(--app-fg)]">
                    <MarkdownRenderer content={props.title} />
                </div>
                {props.description ? (
                    <div className="mt-0.5 [&_.aui-md]:text-xs [&_.aui-md]:text-[var(--app-hint)]">
                        <MarkdownRenderer content={props.description} />
                    </div>
                ) : null}
            </span>
        </button>
    )
}

export function RequestUserInputFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const parsed = useMemo(() => parseRequestUserInputInput(props.tool.input), [props.tool.input])
    const questions = parsed.questions

    const [step, setStep] = useState(0)
    const [stateByQuestion, setStateByQuestion] = useState<Record<string, RequestUserInputQuestionAnswer>>({})

    const [loading, setLoading] = useState(false)
    const [dismissed, setDismissed] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        setStep(0)
        const initial: Record<string, RequestUserInputQuestionAnswer> = {}
        for (const q of questions) {
            initial[q.id] = { selected: [], userNote: q.prefill ?? '' }
        }
        setStateByQuestion(initial)
        setLoading(false)
        setDismissed(false)
        setError(null)
    }, [props.tool.id])

    if (!permission || permission.status !== 'pending' || dismissed) return null
    if (!isRequestUserInputToolName(props.tool.name)) return null
    const nativeAsync = isNativeAsyncQuestionRequest(permission.id)

    const run = async (action: () => Promise<void>, dismiss = false) => {
        if (props.disabled || loading) return
        setLoading(true)
        setError(null)
        try {
            await action()
            if (dismiss) setDismissed(true)
            haptic.notification('success')
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('dialog.error.default'))
        } finally {
            setLoading(false)
        }
    }

    const total = Math.max(1, questions.length)
    const clampedStep = Math.min(Math.max(step, 0), total - 1)
    const currentQuestion = questions[clampedStep] as RequestUserInputQuestion | undefined

    const validateQuestion = (question: RequestUserInputQuestion): boolean => {
        return isRequestUserInputQuestionAnswered(question, stateByQuestion[question.id])
    }

    const submit = async () => {
        if (props.disabled || loading) return

        // Validate all questions
        for (let i = 0; i < questions.length; i += 1) {
            const q = questions[i]
            if (!validateQuestion(q)) {
                setError(t('tool.selectOption'))
                setStep(i)
                return
            }
        }

        // Format answers for submission
        const formattedAnswers = formatRequestUserInputAnswers(stateByQuestion, questions, nativeAsync)

        if (parsed.url) {
            if (!isRequestUserInputUrlConfirmed(parsed, stateByQuestion)) {
                setError(t('tool.selectOption'))
                return
            }
            if (!openRequestUserInputUrl(parsed.url)) {
                setError(t('tool.requestUserInput.popupBlocked'))
                haptic.notification('error')
                return
            }
        }

        await run(() => props.api.approvePermission(props.sessionId, permission.id, formattedAnswers))
    }

    const next = () => {
        if (!currentQuestion) return
        if (!validateQuestion(currentQuestion)) {
            setError(t('tool.selectOption'))
            return
        }
        setError(null)
        setStep((s) => Math.min(s + 1, questions.length - 1))
    }

    const prev = () => {
        setError(null)
        setStep((s) => Math.max(s - 1, 0))
    }

    const selectOption = (question: RequestUserInputQuestion, option: RequestUserInputOption) => {
        haptic.selection()
        setError(null)
        setStateByQuestion((prev) => ({
            ...prev,
            [question.id]: {
                ...prev[question.id],
                selected: selectRequestUserInputOption(question, prev[question.id]?.selected ?? [], option)
            }
        }))
    }

    const updateText = (questionId: string, field: 'userNote' | 'supplementalNote', value: string) => {
        setStateByQuestion((prev) => ({
            ...prev,
            [questionId]: {
                ...prev[questionId],
                [field]: value
            }
        }))
    }

    const currentState = currentQuestion ? stateByQuestion[currentQuestion.id] : null
    const isPureTextQuestion = currentQuestion && currentQuestion.options.length === 0
    const options = currentQuestion ? requestUserInputOptions(currentQuestion) : []
    const customSelected = options.some((option) => option.isOther && currentState?.selected.includes(option.label))

    return (
        <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Badge variant="default">
                            {t('tool.question')}
                        </Badge>
                        <span className="font-mono text-xs text-[var(--app-hint)]">
                            [{clampedStep + 1}/{total}]
                        </span>
                    </div>
                </div>
                <DismissQuestionButton
                    disabled={props.disabled || loading}
                    onClick={() => run(() => props.api.denyPermission(props.sessionId, permission.id, { decision: 'abort' }), true)}
                />
            </div>

            {error ? (
                <div className="mt-2 text-xs text-red-600" role="alert">
                    {error}
                </div>
            ) : null}

            {currentQuestion ? (
                <div className="mt-3">
                    {currentQuestion.question ? (
                        <div>
                            <MarkdownRenderer content={currentQuestion.question} />
                        </div>
                    ) : null}

                    {isPureTextQuestion ? (
                        <QuestionAnswerInput
                            key={currentQuestion.id}
                            aria-label={currentQuestion.placeholder ?? t('tool.requestUserInput.textPlaceholder')}
                            value={currentState?.userNote ?? ''}
                            onChange={(e) => updateText(currentQuestion.id, 'userNote', e.target.value)}
                            disabled={props.disabled || loading}
                            placeholder={currentQuestion.placeholder ?? t('tool.requestUserInput.textPlaceholder')}
                            className="mt-3 rounded-md bg-[var(--app-bg)]"
                        />
                    ) : (
                        <>
                            <div className="mt-3 flex flex-col gap-1">
                                {options.map((opt, optIdx) => {
                                    const isSelected = currentState?.selected.includes(opt.label) ?? false
                                    return (
                                        <OptionRow
                                            key={optIdx}
                                            checked={isSelected}
                                            disabled={props.disabled || loading}
                                            title={opt.isOther ? t('tool.otherDescription') : opt.label}
                                            description={opt.description}
                                            onClick={() => selectOption(currentQuestion, opt)}
                                        />
                                    )
                                })}
                            </div>

                            {customSelected ? (
                                <QuestionAnswerInput
                                    key={currentQuestion.id}
                                    autoFocus
                                    aria-label={t('tool.otherDescription')}
                                    value={currentState?.userNote ?? ''}
                                    onChange={(e) => updateText(currentQuestion.id, 'userNote', e.target.value)}
                                    disabled={props.disabled || loading}
                                    placeholder={t('tool.requestUserInput.textPlaceholder')}
                                    className="mt-3 rounded-md bg-[var(--app-bg)]"
                                />
                            ) : null}
                            {!customSelected ? (
                                <QuestionAnswerInput
                                    key={`note:${currentQuestion.id}`}
                                    aria-label={t('tool.requestUserInput.noteLabel')}
                                    value={currentState?.supplementalNote ?? ''}
                                    onChange={(e) => updateText(currentQuestion.id, 'supplementalNote', e.target.value)}
                                    disabled={props.disabled || loading}
                                    placeholder={t('tool.requestUserInput.notePlaceholder')}
                                    className="mt-3 min-h-[60px] rounded-md bg-[var(--app-bg)]"
                                />
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    {questions.length > 1 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading || clampedStep === 0}
                            onClick={prev}
                        >
                            {t('tool.prev')}
                        </Button>
                    ) : null}
                </div>

                <div className="flex items-center gap-2">
                    {questions.length > 1 && clampedStep < questions.length - 1 ? (
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={next}
                        >
                            {t('tool.next')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={submit}
                            aria-busy={loading}
                            className="gap-2"
                        >
                            {loading ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                    {t('tool.submitting')}
                                </>
                            ) : (
                                t('tool.submit')
                            )}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    )
}
