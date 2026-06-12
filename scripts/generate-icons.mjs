import sharp from 'sharp'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const svgBuffer = readFileSync(join(root, 'public', 'icons', 'icon.svg'))

await sharp(svgBuffer).resize(192, 192).png().toFile(join(root, 'public', 'icons', 'icon-192.png'))
console.log('✓ icon-192.png')

await sharp(svgBuffer).resize(512, 512).png().toFile(join(root, 'public', 'icons', 'icon-512.png'))
console.log('✓ icon-512.png')
