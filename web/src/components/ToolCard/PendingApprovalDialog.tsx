import type { ApiClient } from '@/api/client'
import type { AgentState, SessionMetadataSummary } from '@/types/api'
import { pendingApprovalBlock } from '@/lib/approveCommand'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToolDetailDialogContent } from './ToolCard'
import { PermissionFooter } from './PermissionFooter'
import { useTranslation } from '@/lib/use-translation'

/** Opens the existing tool-detail and permission controls for the same live request. */
export function PendingApprovalDialog(props: {
    api: ApiClient; sessionId: string; metadata: SessionMetadataSummary | null
    state: AgentState | null | undefined; requestId: string | null; disabled: boolean
    onClose: () => void; onRefresh: () => void
}) {
    const { t } = useTranslation()
    const block = props.requestId ? pendingApprovalBlock(props.state, props.requestId) : null
    return <Dialog open={Boolean(block)} onOpenChange={open => { if (!open) props.onClose() }}>
        {block ? <DialogContent className="max-w-2xl" closeButtonClassName="top-2" aria-describedby={undefined}>
            <DialogHeader className="text-left"><DialogTitle>{block.tool.name} · {t('tool.waitingForApproval')}</DialogTitle></DialogHeader>
            <ToolDetailDialogContent block={block} metadata={props.metadata} footer={
                <PermissionFooter api={props.api} sessionId={props.sessionId} metadata={props.metadata}
                    tool={block.tool} disabled={props.disabled} onDone={() => { props.onClose(); props.onRefresh() }} />
            } />
        </DialogContent> : null}
    </Dialog>
}
