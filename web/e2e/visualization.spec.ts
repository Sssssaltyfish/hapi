import { expect, test } from '@playwright/test'

for (const native of [false, true]) {
    test(`visualization reads ${native ? 'native' : 'runner'} files and restores local interaction state`, async ({ page }) => {
        page.on('pageerror', error => console.error(error.message))
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto('/e2e-fixtures/visualization-fixture.html' + (native ? '?native=1' : ''))
        const iframe = page.locator('iframe').first()
        const widget = page.frameLocator('iframe').first()
        await expect(widget.getByRole('slider', { name: 'Count' })).toHaveValue('2')
        await expect(page.locator('html')).toHaveAttribute('data-reader', native ? 'native' : 'runner')
        await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
        await expect.poll(async () => iframe.evaluate(element => element.clientWidth <= document.documentElement.clientWidth)).toBe(true)

        await widget.getByRole('slider').fill('7')
        await expect(widget.locator('#widget-value')).toHaveText('7')
        await page.getByRole('button', { name: 'Toggle message' }).click()
        await page.getByRole('button', { name: 'Toggle message' }).click()
        await expect(widget.getByRole('slider')).toHaveValue('7')
        await expect(page.locator('html')).toHaveAttribute('data-file-reads', '1')
        await page.getByRole('button', { name: 'Toggle theme' }).click()
        await expect(widget.locator('#widget-theme')).toHaveText('dark')

        await page.getByRole('button', { name: 'Preview Counter', exact: true }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(widget.getByRole('slider')).toHaveValue('7')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).not.toBeVisible()
        await expect(widget.getByRole('slider')).toHaveValue('7')

        await widget.getByRole('button', { name: 'Ask about count' }).click()
        await expect(page.getByTestId('draft')).toBeEmpty()
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(page.getByTestId('draft')).toBeEmpty()
        await widget.getByRole('button', { name: 'Ask about count' }).click()
        await page.getByRole('button', { name: 'Add to draft', exact: true }).click()
        await expect(page.getByTestId('draft')).toHaveText('Explain count 7')
        await expect(page.locator('html')).not.toHaveAttribute('data-sent')
        await page.reload()
        await expect(widget.getByRole('slider')).toHaveValue('7')
    })
}
