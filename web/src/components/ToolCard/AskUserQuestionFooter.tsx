import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { isAskUserQuestionToolName, parseAskUserQuestionInput, type AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'
import { isCursorAskQuestionToolName, parseCursorAskQuestionInput } from '@/components/ToolCard/cursorAskQuestion'
import {
    AskUserQuestionOptionBody,
    askUserQuestionQuoteClassName,
    getAskUserQuestionOptionFrameClassName,
    type AskUserQuestionChoiceMode
} from '@/components/ToolCard/askUserQuestionOptionCard'
import {
    askUserQuestionDraftKey,
    clearAskUserQuestionDraft,
    getAskUserQuestionDraft,
    saveAskUserQuestionDraft,
} from '@/lib/ask-user-question-drafts'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'
import { isCustomQuestionOption } from './customQuestionOption'
import { DismissQuestionButton, QuestionAnswerInput } from './questionControls'

const questionNavButtonClassName = 'h-8 rounded-full border-[var(--app-border)] bg-[var(--app-tool-card-bg)] px-3.5 text-[var(--app-fg)] hover:border-[var(--app-md-quote-border)] hover:bg-[var(--app-subtle-bg)]'

function OptionRow(props: {
    checked: boolean
    mode: AskUserQuestionChoiceMode
    disabled: boolean
    title: string
    description?: string | null
    onClick: () => void
}) {
    return (
        <button
            type="button"
            role={props.mode === 'multi' ? 'checkbox' : 'radio'}
            aria-checked={props.checked}
            className={getAskUserQuestionOptionFrameClassName(
                props.checked,
                'w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50'
            )}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <AskUserQuestionOptionBody
                checked={props.checked}
                mode={props.mode}
                title={props.title}
                description={props.description}
                interactive
            />
        </button>
    )
}

function computeAnswersForQuestion(
    question: AskUserQuestionQuestion,
    selectedOptionIndices: number[],
    otherSelected: boolean,
    otherText: string,
    useStableIds: boolean
): string[] {
    if (otherSelected || question.options.length === 0) {
        const answer = otherText.trim()
        return answer ? [answer] : []
    }

    const answers: string[] = []

    for (const idx of selectedOptionIndices) {
        const opt = question.options[idx]
        if (!opt) continue
        if (useStableIds) {
            const optionId = opt.id?.trim() || opt.label.trim()
            if (optionId.length > 0) {
                answers.push(optionId)
            }
            continue
        }
        const label = opt.label.trim()
        if (label.length > 0) {
            answers.push(label)
        }
    }

    return answers
}

export function AskUserQuestionFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const useStableQuestionIds = isCursorAskQuestionToolName(props.tool.name)
    const parsed = useMemo(() => (
        useStableQuestionIds
            ? parseCursorAskQuestionInput(props.tool.input)
            : parseAskUserQuestionInput(props.tool.input)
    ), [props.tool.name, props.tool.input, useStableQuestionIds])
    const questions = parsed.questions

    const draftKey = askUserQuestionDraftKey(props.sessionId, props.tool.id)

    const [step, setStep] = useState(0)
    const [selectedByQuestion, setSelectedByQuestion] = useState<number[][]>([])
    const [otherSelectedByQuestion, setOtherSelectedByQuestion] = useState<boolean[]>([])
    const [otherTextByQuestion, setOtherTextByQuestion] = useState<string[]>([])
    const [fallbackText, setFallbackText] = useState('')

    const [loading, setLoading] = useState(false)
    const [dismissed, setDismissed] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Mirrors the answer-in-progress fields above so the cleanup below can
    // persist the latest values without depending on them (which would tear
    // down and rebuild the draft-restore effect on every keystroke).
    const draftStateRef = useRef({ step, selectedByQuestion, otherSelectedByQuestion, otherTextByQuestion, fallbackText })
    draftStateRef.current = { step, selectedByQuestion, otherSelectedByQuestion, otherTextByQuestion, fallbackText }
    // Set once `run` below submits or denies successfully, so an unmount that
    // follows (e.g. a session switch right after answering) can't resurrect
    // the just-cleared draft via the cleanup's own save.
    const submittedRef = useRef(false)

    useEffect(() => {
        // Restores a session-switch remount's own in-progress answer (SessionChat
        // keys the whole subtree by session.id — see its own comment), and, since
        // draftKey also changes for a genuinely new question, still resets to
        // blank when this instance is reused for a different tool call (hapi#1734).
        submittedRef.current = false
        const draft = getAskUserQuestionDraft(draftKey)
        const otherSelected = questions.map((question, index) => (
            draft?.otherSelectedByQuestion[index] || draft?.selectedByQuestion[index]?.some((optionIndex) => {
                const option = question.options[optionIndex]
                return option && isCustomQuestionOption(option)
            }) || false
        ))
        const restored = {
            step: draft?.step ?? 0,
            selectedByQuestion: questions.map((_, index) => otherSelected[index] ? [] : draft?.selectedByQuestion[index] ?? []),
            otherSelectedByQuestion: otherSelected,
            otherTextByQuestion: draft?.otherTextByQuestion ?? questions.map(() => ''),
            fallbackText: draft?.fallbackText ?? '',
        }
        // React (StrictMode, dev only) replays this effect as setup → cleanup →
        // setup right on mount, before the setState calls below have flowed
        // through a render. Without this, the cleanup's save would read the
        // ref's still-pre-restore render values and, being blank, delete the
        // draft this same effect just loaded — so the replayed setup restores
        // nothing. Setting the ref here makes the premature cleanup a harmless
        // re-save of exactly what was just loaded.
        draftStateRef.current = restored
        setStep(restored.step)
        setSelectedByQuestion(restored.selectedByQuestion)
        setOtherSelectedByQuestion(restored.otherSelectedByQuestion)
        setOtherTextByQuestion(restored.otherTextByQuestion)
        setFallbackText(restored.fallbackText)
        setLoading(false)
        setDismissed(false)
        setError(null)

        return () => {
            if (!submittedRef.current) {
                saveAskUserQuestionDraft(draftKey, draftStateRef.current)
            }
        }
    }, [draftKey])

    if (!permission || permission.status !== 'pending' || dismissed) return null
    if (!isAskUserQuestionToolName(props.tool.name)) return null

    const run = async (action: () => Promise<void>, dismiss = false) => {
        if (props.disabled || loading) return
        setLoading(true)
        setError(null)
        try {
            await action()
            submittedRef.current = true
            clearAskUserQuestionDraft(draftKey)
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

    const mode: AskUserQuestionChoiceMode = questions[clampedStep]?.multiSelect ? 'multi' : 'single'

    const validateQuestion = (idx: number): string[] | null => {
        if (questions.length === 0) {
            const text = fallbackText.trim()
            return text.length > 0 ? [text] : null
        }

        const question = questions[idx]
        if (!question) return null
        const answers = computeAnswersForQuestion(
            question,
            selectedByQuestion[idx] ?? [],
            otherSelectedByQuestion[idx] ?? false,
            otherTextByQuestion[idx] ?? '',
            useStableQuestionIds
        )
        return answers.length > 0 ? answers : null
    }

    const questionAnswerKey = (question: AskUserQuestionQuestion, index: number): string => (
        useStableQuestionIds && question.id?.trim()
            ? question.id.trim()
            : String(index)
    )

    const submit = async () => {
        if (props.disabled || loading) return

        const answers: Record<string, string[]> = {}
        if (questions.length === 0) {
            const a0 = validateQuestion(0)
            if (!a0) {
                setError(t('tool.selectOption'))
                return
            }
            answers['0'] = a0
        } else {
            for (let i = 0; i < questions.length; i += 1) {
                const a = validateQuestion(i)
                if (!a) {
                    setError(t('tool.selectOption'))
                    setStep(i)
                    return
                }
                const q = questions[i]
                if (!q) {
                    continue
                }
                answers[questionAnswerKey(q, i)] = a
            }
        }

        await run(() => props.api.approvePermission(props.sessionId, permission.id, { answers }))
    }

    const next = () => {
        if (questions.length === 0) return
        const a = validateQuestion(clampedStep)
        if (!a) {
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

    const toggleOption = (qIdx: number, optIdx: number) => {
        const q = questions[qIdx]
        if (!q) return
        haptic.selection()
        setError(null)

        setSelectedByQuestion((prevSelected) => {
            const nextSelected = prevSelected.slice()
            const cur = new Set(nextSelected[qIdx] ?? [])
            if (q.multiSelect) {
                if (cur.has(optIdx)) cur.delete(optIdx)
                else cur.add(optIdx)
                nextSelected[qIdx] = Array.from(cur).sort((a, b) => a - b)
                return nextSelected
            }

            nextSelected[qIdx] = [optIdx]
            return nextSelected
        })

        setOtherSelectedByQuestion((prevOther) => {
            const nextOther = prevOther.slice()
            nextOther[qIdx] = false
            return nextOther
        })
    }

    const toggleOther = (qIdx: number) => {
        const q = questions[qIdx]
        if (!q) return
        haptic.selection()
        setError(null)

        setSelectedByQuestion((prevSelected) => {
            const nextSelected = prevSelected.slice()
            nextSelected[qIdx] = []
            return nextSelected
        })
        setOtherSelectedByQuestion((prevOther) => {
            const nextOther = prevOther.slice()
            nextOther[qIdx] = !q.multiSelect || !nextOther[qIdx]
            return nextOther
        })
    }

    const updateOtherText = (qIdx: number, value: string) => {
        setOtherTextByQuestion((prevText) => {
            const nextText = prevText.slice()
            nextText[qIdx] = value
            return nextText
        })
    }

    const currentQuestion = questions[clampedStep]
    const isPureTextQuestion = currentQuestion?.options.length === 0
    const otherSelected = otherSelectedByQuestion[clampedStep] ?? false

    return (
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Badge variant="default">
                            {t('tool.question')}
                        </Badge>
                        <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 font-mono text-[11px] text-[var(--app-hint)]">
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

            {!currentQuestion ? (
                <div className="mt-3">
                    <div className="text-sm text-[var(--app-hint)]">
                        {t('tool.askUserQuestion.fallback')}
                    </div>
                    <QuestionAnswerInput
                        aria-label={t('tool.askUserQuestion.placeholder')}
                        value={fallbackText}
                        onChange={(e) => setFallbackText(e.target.value)}
                        disabled={props.disabled || loading}
                        placeholder={t('tool.askUserQuestion.placeholder')}
                        className="mt-2 rounded-xl bg-[var(--app-tool-card-bg)]"
                    />
                </div>
            ) : (
                <div className="mt-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            {currentQuestion.header ? (
                                <div className="flex items-center gap-2">
                                    <Badge variant="default">
                                        {currentQuestion.header}
                                    </Badge>
                                </div>
                            ) : null}
                            {currentQuestion.question ? (
                                <div className={cn(
                                    askUserQuestionQuoteClassName,
                                    currentQuestion.header ? 'mt-2' : ''
                                )}>
                                    <MarkdownRenderer content={currentQuestion.question} />
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="mt-3 flex flex-col gap-1.5">
                        {currentQuestion.options.map((opt, optIdx) => {
                            if (isCustomQuestionOption(opt)) return null
                            const selected = (selectedByQuestion[clampedStep] ?? []).includes(optIdx)
                            return (
                                <OptionRow
                                    key={optIdx}
                                    checked={selected}
                                    mode={mode}
                                    disabled={props.disabled || loading}
                                    title={opt.label}
                                    description={opt.description}
                                    onClick={() => toggleOption(clampedStep, optIdx)}
                                />
                            )
                        })}

                        {!isPureTextQuestion ? (
                            <OptionRow
                                checked={otherSelected}
                                mode={mode}
                                disabled={props.disabled || loading}
                                title={t('tool.otherDescription')}
                                onClick={() => toggleOther(clampedStep)}
                            />
                        ) : null}

                        {isPureTextQuestion || otherSelected ? (
                            <QuestionAnswerInput
                                key={clampedStep}
                                autoFocus={!isPureTextQuestion}
                                aria-label={t('tool.askUserQuestion.placeholder')}
                                value={otherTextByQuestion[clampedStep] ?? ''}
                                onChange={(e) => updateOtherText(clampedStep, e.target.value)}
                                disabled={props.disabled || loading}
                                placeholder={t('tool.askUserQuestion.placeholder')}
                                className="mt-2 rounded-xl bg-[var(--app-tool-card-bg)]"
                            />
                        ) : null}
                    </div>
                </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--app-border)] pt-3">
                <div className="flex items-center gap-2">
                    {questions.length > 1 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading || clampedStep === 0}
                            onClick={prev}
                            className={questionNavButtonClassName}
                        >
                            {t('tool.prev')}
                        </Button>
                    ) : null}
                </div>

                <div className="flex items-center gap-2">
                    {questions.length > 1 && clampedStep < questions.length - 1 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={next}
                            className={questionNavButtonClassName}
                        >
                            {t('tool.next')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={submit}
                            aria-busy={loading}
                            className={cn(questionNavButtonClassName, 'gap-2')}
                        >
                            {loading ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-[var(--app-fg)]" />
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
