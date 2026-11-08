import { useCallback, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type SyntheticEvent, type WheelEvent } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { CloseIcon } from '@/components/icons'

const MIN_IMAGE_SCALE = 0.25
const MAX_IMAGE_SCALE = 8
const IMAGE_SCALE_STEP = 0.25
const BACKDROP_CLICK_MAX_MOVEMENT = 4

let touchViewport = typeof window === 'undefined'
    ? undefined
    : { width: window.innerWidth, height: window.innerHeight }

function getImageViewportHeight() {
    const { innerWidth: width, innerHeight: height } = window
    if (!window.matchMedia?.('(pointer: coarse)').matches) return height
    // Chrome's resizes-content keyboard changes layout viewport units as
    // well. Preserve the image's fit and center while that viewport shrinks,
    // but measure again for rotation. The dialog itself still fits the screen.
    if (touchViewport?.width !== width || height > touchViewport.height) touchViewport = { width, height }
    return touchViewport.height
}

function clampImageScale(value: number): number {
    return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, value))
}

type ImagePoint = { x: number; y: number }

type PreviewImage = {
    trigger: HTMLButtonElement
    src: string
    fileName: string
    label: string
}

function getPointDistance(a: ImagePoint, b: ImagePoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

function getPointCenter(a: ImagePoint, b: ImagePoint): ImagePoint {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
    }
}

export function ImagePreview(props: {
    src: string
    fileName: string
    label: string
    buttonClassName?: string
    imageClassName?: string
    imageStyle?: CSSProperties
    sourceRevision?: number
    imageLoading?: ComponentPropsWithoutRef<'img'>['loading']
    referrerPolicy?: ComponentPropsWithoutRef<'img'>['referrerPolicy']
    caption?: ReactNode
    onError?: () => void
    onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void
    galleryId?: string
    onTriggerPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void
    onTriggerContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void
    onTriggerClick?: (event: MouseEvent<HTMLButtonElement>) => void
}) {
    const [viewerOpen, setViewerOpen] = useState(false)
    const [previewImages, setPreviewImages] = useState<PreviewImage[]>([])
    const [previewIndex, setPreviewIndex] = useState(0)
    const [scale, setScale] = useState(1)
    const [offset, setOffset] = useState({ x: 0, y: 0 })
    const [imageFrameHeight, setImageFrameHeight] = useState<number>()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const scaleRef = useRef(scale)
    const offsetRef = useRef(offset)
    const activePointersRef = useRef(new Map<number, ImagePoint>())
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
    const pinchRef = useRef<{ startDistance: number; startScale: number; startCenter: ImagePoint; origin: ImagePoint } | null>(null)
    const backdropPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
    const backdropClickRef = useRef(false)

    const attachViewerCanvas = useCallback((canvas: HTMLDivElement | null) => {
        if (!canvas) return
        const measure = () => setImageFrameHeight(Math.max(1, getImageViewportHeight() - canvas.getBoundingClientRect().top))
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
    }, [])

    const stopEvent = useCallback((event: SyntheticEvent) => {
        event.stopPropagation()
    }, [])

    const openViewer = useCallback((event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault()
        event.stopPropagation()
        const galleryId = props.galleryId ?? ''
        const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-image-preview-trigger]'))
            .filter((trigger) => (trigger.dataset.imagePreviewGallery ?? '') === galleryId)
        const images = triggers.flatMap((trigger): PreviewImage[] => {
            const image = trigger.querySelector('img')
            if (!image) return []
            return [{
                trigger,
                src: image.getAttribute('src') ?? image.src,
                fileName: trigger.dataset.imagePreviewFileName ?? image.alt,
                label: trigger.dataset.imagePreviewLabel ?? image.alt
            }]
        })
        const index = triggers.indexOf(event.currentTarget)
        setPreviewImages(images)
        setPreviewIndex(index >= 0 ? index : 0)
        setViewerOpen(true)
    }, [props.galleryId])

    const handleTriggerPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
        props.onTriggerPointerDown?.(event)
        stopEvent(event)
    }, [props.onTriggerPointerDown, stopEvent])

    const handleTriggerClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
        props.onTriggerClick?.(event)
        if (event.defaultPrevented) return
        openViewer(event)
    }, [openViewer, props.onTriggerClick])

    const updateScale = useCallback((next: number | ((current: number) => number)) => {
        setScale((current) => {
            const value = typeof next === 'function' ? next(current) : next
            scaleRef.current = value
            return value
        })
    }, [])

    const updateOffset = useCallback((next: ImagePoint) => {
        offsetRef.current = next
        setOffset(next)
    }, [])

    const resetView = useCallback(() => {
        updateScale(1)
        updateOffset({ x: 0, y: 0 })
    }, [updateOffset, updateScale])

    const closeViewer = useCallback(() => {
        setViewerOpen(false)
        activePointersRef.current.clear()
        dragRef.current = null
        pinchRef.current = null
        backdropPressRef.current = null
        backdropClickRef.current = false
        resetView()
    }, [resetView])

    const showPreview = useCallback((index: number) => {
        setPreviewIndex(index)
        resetView()
    }, [resetView])

    const zoomBy = useCallback((delta: number) => {
        updateScale((current) => clampImageScale(current + delta))
    }, [updateScale])

    const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
        event.preventDefault()
        const delta = event.deltaY < 0 ? IMAGE_SCALE_STEP : -IMAGE_SCALE_STEP
        zoomBy(delta)
    }, [zoomBy])

    const beginPinch = useCallback(() => {
        const pointers = Array.from(activePointersRef.current.values())
        if (pointers.length < 2) return

        const [first, second] = pointers
        pinchRef.current = {
            startDistance: getPointDistance(first, second),
            startScale: scaleRef.current,
            startCenter: getPointCenter(first, second),
            origin: offsetRef.current
        }
        dragRef.current = null
    }, [])

    const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        backdropClickRef.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        backdropPressRef.current = event.target === event.currentTarget
            ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
            : null

        if (activePointersRef.current.size >= 2) {
            backdropPressRef.current = null
            beginPinch()
            return
        }

        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offsetRef.current.x,
            originY: offsetRef.current.y
        }
    }, [beginPinch])

    const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!activePointersRef.current.has(event.pointerId)) return
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

        if (activePointersRef.current.size >= 2 && pinchRef.current) {
            const pointers = Array.from(activePointersRef.current.values())
            const [first, second] = pointers
            const distance = getPointDistance(first, second)
            const center = getPointCenter(first, second)
            const pinch = pinchRef.current
            const nextScale = pinch.startDistance > 0
                ? clampImageScale(pinch.startScale * (distance / pinch.startDistance))
                : pinch.startScale

            updateScale(nextScale)
            updateOffset({
                x: pinch.origin.x + center.x - pinch.startCenter.x,
                y: pinch.origin.y + center.y - pinch.startCenter.y
            })
            return
        }

        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        updateOffset({
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY
        })
    }, [updateOffset, updateScale])

    const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
        const backdropPress = backdropPressRef.current
        const moved = backdropPress
            ? Math.hypot(event.clientX - backdropPress.x, event.clientY - backdropPress.y)
            : Number.POSITIVE_INFINITY
        backdropClickRef.current = event.type === 'pointerup'
            && backdropPress?.pointerId === event.pointerId
            && event.target === event.currentTarget
            && activePointersRef.current.size === 1
            && moved <= BACKDROP_CLICK_MAX_MOVEMENT

        activePointersRef.current.delete(event.pointerId)
        if (backdropPress?.pointerId === event.pointerId) {
            backdropPressRef.current = null
        }
        if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null
        }
        pinchRef.current = null

        const remainingPointer = activePointersRef.current.entries().next().value as [number, ImagePoint] | undefined
        if (remainingPointer) {
            dragRef.current = {
                pointerId: remainingPointer[0],
                startX: remainingPointer[1].x,
                startY: remainingPointer[1].y,
                originX: offsetRef.current.x,
                originY: offsetRef.current.y
            }
        }
    }, [])

    const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
        // Dismiss after the click is targeted, so the same gesture cannot land
        // on the chat underneath after pointerup removes the preview.
        if (backdropClickRef.current && event.target === event.currentTarget) {
            event.preventDefault()
            closeViewer()
        }
        backdropClickRef.current = false
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === '0') resetView()
        else if (event.key === '+' || event.key === '=') zoomBy(IMAGE_SCALE_STEP)
        else if (event.key === '-') zoomBy(-IMAGE_SCALE_STEP)
        else if (event.key === 'ArrowLeft' && previewIndex > 0) showPreview(previewIndex - 1)
        else if (event.key === 'ArrowRight' && previewIndex < previewImages.length - 1) showPreview(previewIndex + 1)
        else return
        event.preventDefault()
        event.stopPropagation()
    }

    const selected = previewImages[previewIndex]
    const showingOwnImage = !selected || selected.trigger === triggerRef.current
    const activePreview = showingOwnImage ? {
        src: props.src,
        fileName: props.fileName,
        label: props.label
    } : selected
    const hasMultiplePreviews = previewImages.length > 1

    return (
        <DialogPrimitive.Root open={viewerOpen} onOpenChange={open => { if (!open) closeViewer() }}>
            <DialogPrimitive.Trigger asChild>
                <button
                    ref={triggerRef}
                    type="button"
                    onPointerDown={handleTriggerPointerDown}
                    onMouseDown={stopEvent}
                    onTouchStart={stopEvent}
                    onContextMenu={props.onTriggerContextMenu}
                    onClick={handleTriggerClick}
                    data-image-preview-trigger=""
                    data-image-preview-file-name={props.fileName}
                    data-image-preview-label={props.label}
                    data-image-preview-gallery={props.galleryId ?? ''}
                    // Keep the hidden filename from escaping into the chat viewport.
                    className={`relative ${props.buttonClassName ?? 'group flex min-h-[18rem] w-full items-center justify-center overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3 text-left'}`}
                    title="Click to zoom"
                >
                    <img
                        key={props.sourceRevision}
                        src={props.src}
                        onError={props.onError}
                        onLoad={props.onLoad}
                        alt={props.label}
                        loading={props.imageLoading}
                        referrerPolicy={props.referrerPolicy}
                        className={props.imageClassName ?? 'max-h-[calc(100vh-14rem)] max-w-full object-contain transition-transform group-hover:scale-[1.01]'}
                        style={props.imageStyle}
                        draggable={false}
                    />
                    {props.caption}
                    <span className="sr-only">{props.fileName}</span>
                </button>
            </DialogPrimitive.Trigger>

            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90" onPointerDown={stopEvent} onClick={stopEvent} />
                <DialogPrimitive.Content
                    className="fixed inset-0 z-50 flex h-[100dvh] flex-col overflow-hidden overscroll-none text-white"
                    aria-modal="true"
                    aria-describedby={undefined}
                    // Keep preview gestures from starting an ancestor's attachment drag.
                    onPointerDown={stopEvent}
                    onMouseDown={stopEvent}
                    onTouchStart={stopEvent}
                    onClick={stopEvent}
                    onKeyDown={handleKeyDown}
                    onCloseAutoFocus={event => {
                        event.preventDefault()
                        triggerRef.current?.focus({ preventScroll: true })
                    }}
                >
                    <DialogPrimitive.Title className="sr-only">{activePreview.label}</DialogPrimitive.Title>
                    <div className="flex items-center gap-2 border-b border-white/10 bg-black/50 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
                        <div className="min-w-0 flex-1 truncate text-sm font-medium">{activePreview.fileName}</div>
                        {hasMultiplePreviews ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => showPreview(previewIndex - 1)}
                                    className="flex h-8 w-8 items-center justify-center rounded bg-white/10 text-lg hover:bg-white/20 disabled:opacity-40"
                                    disabled={previewIndex === 0}
                                    title="Previous image"
                                    aria-label="Previous image"
                                >
                                    ←
                                </button>
                                <span className="min-w-10 text-center text-xs tabular-nums text-white/70">
                                    {previewIndex + 1} / {previewImages.length}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => showPreview(previewIndex + 1)}
                                    className="flex h-8 w-8 items-center justify-center rounded bg-white/10 text-lg hover:bg-white/20 disabled:opacity-40"
                                    disabled={previewIndex === previewImages.length - 1}
                                    title="Next image"
                                    aria-label="Next image"
                                >
                                    →
                                </button>
                            </>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => zoomBy(-IMAGE_SCALE_STEP)}
                            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                            disabled={scale <= MIN_IMAGE_SCALE}
                            title="Zoom out"
                        >
                            −
                        </button>
                        <button
                            type="button"
                            onClick={resetView}
                            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
                            title="Reset zoom"
                        >
                            {Math.round(scale * 100)}%
                        </button>
                        <button
                            type="button"
                            onClick={() => zoomBy(IMAGE_SCALE_STEP)}
                            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                            disabled={scale >= MAX_IMAGE_SCALE}
                            title="Zoom in"
                        >
                            +
                        </button>
                        <DialogPrimitive.Close
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded bg-white/10 hover:bg-white/20"
                            title="Close"
                        >
                            <CloseIcon className="h-4 w-4" />
                        </DialogPrimitive.Close>
                    </div>
                    <div
                        ref={attachViewerCanvas}
                        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
                        onWheel={handleWheel}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                        onClick={handleBackdropClick}
                        onDoubleClick={resetView}
                    >
                        <img
                            key={showingOwnImage ? props.sourceRevision : undefined}
                            src={activePreview.src}
                            alt={activePreview.label}
                            onError={showingOwnImage ? props.onError : undefined}
                            referrerPolicy={props.referrerPolicy}
                            draggable={false}
                            className="absolute left-1/2 top-1/2 max-h-[90vh] max-w-[90vw] select-none object-contain"
                            style={{
                                top: imageFrameHeight === undefined ? undefined : imageFrameHeight / 2,
                                maxHeight: imageFrameHeight === undefined ? undefined : imageFrameHeight * 0.9,
                                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                                transformOrigin: 'center center'
                            }}
                        />
                    </div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
