import type { Processor } from 'unified'
import { nativeSkillReferenceAtStart } from '@/codex-native/skillReferences'

const TOKEN = 'hapiNativeSkill'
type Code = number | null
type State = (code: Code) => State | undefined
type Token = { type: string }
type Effects = { enter(type: string): void; consume(code: Code): void; exit(type: string): Token }
type CompileContext = {
    enter(node: { type: string; value: string; data: unknown }, token: Token): void
    exit(token: Token): void
    sliceSerialize(token: Token): string
}

// Desktop accepts raw spaces and escapes closing parentheses in link paths.
// Recognize its link form before the normal Markdown link parser.
function tokenize(this: { sliceSerialize(token: Token): string }, effects: Effects, ok: State, nok: State): State {
    const serialize = this.sliceSerialize.bind(this)
    let escaped = false
    let length = 0
    return start

    function start(code: Code) {
        effects.enter(TOKEN)
        effects.consume(code)
        return dollar
    }

    function dollar(code: Code): State | undefined {
        if (code !== 36) return nok(code)
        effects.consume(code)
        return label
    }

    function label(code: Code): State | undefined {
        if (code === null || code <= 32 || code === 91 || code === 92 || ++length > 256) return nok(code)
        effects.consume(code)
        return code === 93 ? open : label
    }

    function open(code: Code): State | undefined {
        if (code !== 40) return nok(code)
        effects.consume(code)
        return body
    }

    function body(code: Code): State | undefined {
        if (code === null || code < -2 || ++length > 4096) return nok(code)
        effects.consume(code)
        if (code === 41 && !escaped) {
            const token = effects.exit(TOKEN)
            return nativeSkillReferenceAtStart(serialize(token)) ? ok : nok
        }
        escaped = !escaped && code === 92
        return body
    }
}

export function remarkNativeSkillLinks(this: Processor) {
    const data = this.data()
    const syntax = (data.micromarkExtensions ??= []) as unknown[]
    const compiler = (data.fromMarkdownExtensions ??= []) as unknown[]
    syntax.push({ text: { 91: { tokenize } } })
    compiler.push({
        enter: {
            [TOKEN](this: CompileContext, token: Token) {
                const value = this.sliceSerialize(token)
                const reference = nativeSkillReferenceAtStart(value)!
                this.enter({ type: TOKEN, value, data: {
                    hName: 'hapi-native-skill',
                    hProperties: { title: reference.value },
                } }, token)
            },
        },
        exit: { [TOKEN](this: CompileContext, token: Token) { this.exit(token) } },
    })
}
