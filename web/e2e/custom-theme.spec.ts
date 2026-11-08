import { expect, test } from '@playwright/test'

test('restores a saved theme including its background after exporting, importing, and reloading', async ({ page }) => {
    await page.goto('/e2e-fixtures/settings-fixture.html')
    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 4
        const context = canvas.getContext('2d')!
        context.fillStyle = '#6b4ee8'
        context.fillRect(0, 0, 4, 4)
        return canvas.toDataURL().split(',')[1]!
    })

    await page.getByText('One', { exact: true }).click()
    await page.locator('input[type=file][accept^="image/jpeg"]').setInputFiles({
        name: 'background.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64'),
    })
    const root = page.locator('html')
    const brightness = page.getByRole('slider', { name: 'Brightness' })
    await expect(brightness).toHaveValue('100')
    await brightness.press('ArrowLeft')
    await page.getByRole('slider', { name: 'Blur' }).press('ArrowRight')
    await expect(root).toHaveCSS('--hapi-background-brightness', '99%')
    await expect(root).toHaveCSS('--hapi-background-blur', '1px')

    await page.getByRole('button', { name: 'Save current scheme' }).click()
    await page.getByRole('textbox', { name: 'Scheme name' }).fill('Evening')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('textbox', { name: 'Scheme name' }).fill('Nightfall')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('option', { name: 'Nightfall' })).toBeAttached()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('Nightfall.hapi-theme.json')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(root).not.toHaveAttribute('data-custom-background')
    await page.getByText('Notion', { exact: true }).click()
    await page.locator('input[type=file][accept=".json,application/json"]').setInputFiles(await download.path())
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(root).toHaveAttribute('data-color-theme', 'one')
    await expect(root).toHaveAttribute('data-custom-background', '')

    await page.reload()
    await expect(root).toHaveAttribute('data-color-theme', 'one')
    await expect(root).toHaveCSS('--hapi-background-brightness', '99%')
    await expect(root).toHaveCSS('--hapi-background-blur', '1px')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).toContain('blob:')
})
