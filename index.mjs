import { Option, program } from 'commander'
import path from 'path'
import chalk from 'chalk'
import PImage from 'pureimage'
import fs from 'fs'
import fsp from 'fs/promises'
import { Bitmap } from 'pureimage/src/bitmap.js'

const MAGIC = [99, 115, 113, 47, 113, 105, 109, 103] // csq/qimg

function generateOutputPath(input, extension) {
    let inputExtension = path.extname(input)
    
    let filename = path.basename(input, inputExtension)
    let dir = path.dirname(input)
    
    let output = path.resolve(dir, filename + '.' + extension)

    return output
}

function getLuminance(color) {
    let r = color.r
    let g = color.g
    let b = color.b
    return Math.sqrt((0.241 * r * r) + (0.691 * g * g) + (0.068 * b * b)) / 255
}

// converts an image (with width, height and data) into a boxed representation
function boxify(image, boxSize) {
    let imageData = Array.from(image.data)

    let size = {
        width: image.width - (image.width % boxSize),
        height: image.height - (image.height % boxSize),
    }

    let data = []

    for(let yStart = 0; yStart < size.height; yStart += boxSize) {
        for(let xStart = 0; xStart < size.width; xStart += boxSize) {
            let box = {
                x: xStart / boxSize,
                y: yStart / boxSize,
                data: [],
            }

            for(let y = 0; y < boxSize; y++) {
                for(let x = 0; x < boxSize; x++) {
                    let realY = yStart + y
                    let realX = xStart + x

                    let index = (realY * image.width) + realX

                    let pixel = {
                        x,
                        y,
                        color: {
                            r: imageData[index * 4],
                            g: imageData[index * 4 + 1],
                            b: imageData[index * 4 + 2],
                        }
                    }
                    
                    box.data.push(pixel)
                }
            }

            data.push(box)
        }
    }

    return {
        size: {
            width: size.width / boxSize,
            height: size.height / boxSize,
        },
        boxSize,
        data,
    }
}

// compresses a boxed image so that each box has 2 colours
// and the pixels are no longer rgb but a simple palette index
function pack({ size, boxSize, data }) {
    let boxes = []

    for(let box of data) {
        let newBox = {
            x: box.x,
            y: box.y,
            data: [],
        }

        let totalLuminance = box.data.reduce((accumulator, current) => accumulator + getLuminance(current.color), 0)
        let averageLuminance = totalLuminance / box.data.length

        let totals = {
            light: { r: 0, g: 0, b: 0, n: 0 },
            dark: { r: 0, g: 0, b: 0, n: 0 },
        }

        for(let pixel of box.data) {
            let luminance = getLuminance(pixel.color)

            let type = luminance >= averageLuminance ? 'light' : 'dark'
            totals[type].n++
            totals[type].r += pixel.color.r
            totals[type].g += pixel.color.g
            totals[type].b += pixel.color.b
        }

        newBox.light = {}
        newBox.dark = {}

        newBox.light.r = Math.floor(totals.light.r / totals.light.n)
        newBox.light.g = Math.floor(totals.light.g / totals.light.n)
        newBox.light.b = Math.floor(totals.light.b / totals.light.n)
        newBox.dark.r = Math.floor(totals.dark.r / totals.dark.n)
        newBox.dark.g = Math.floor(totals.dark.g / totals.dark.n)
        newBox.dark.b = Math.floor(totals.dark.b / totals.dark.n)

        for(let pixel of box.data) {
            let luminance = getLuminance(pixel.color)

            let newPixel = {
                x: pixel.x,
                y: pixel.y,
                index: luminance >= averageLuminance ? 1 : 0
            }

            newBox.data.push(newPixel)
        }

        boxes.push(newBox)
    }

    return {
        size,
        boxSize,
        data: boxes,
    }
}

function unpack({ size, boxSize, data }) {
    let width = size.width * boxSize
    let height = size.height * boxSize

    let imageData = new Array(width * height * 4)
        .fill(0) // have to fill before we can map :(
        .map((_, index) => index % 4 == 3 ? 255 : 0) // full alpha

    for(let box of data) {
        for(let pixel of box.data) {
            let x = (box.x * boxSize) + pixel.x
            let y = (box.y * boxSize) + pixel.y

            let realY = width * y
            let index = (realY + x) * 4

            let color = pixel.index == 0 ? box.dark : box.light

            imageData[index] = color.r
            imageData[index + 1] = color.g
            imageData[index + 2] = color.b
            imageData[index + 3] = 255
        }
    }

    let bitmap = new Bitmap(width, height)

    bitmap.data = imageData

    return bitmap
}

function serialiseFromPacked({ size, boxSize, data }) {
    let bytes = []

    let magic = MAGIC

    let version = [0, 1]

    bytes.push(...magic)
    bytes.push(...version)

    if(boxSize > 255 || size.width > 255 || size.height > 255) {
        console.error('one of the following values is too large to be serialised:')
        console.error(`   box size: ${ boxSize }`)
        console.error(`      width: ${ size.width }`)
        console.error(`     height: ${ size.height }`)
        process.exit()
    }

    bytes.push(boxSize)

    bytes.push(size.width)
    bytes.push(size.height)

    let dataLength = [
        (data.length & (0xFF << 16)) >> 16,
        (data.length & (0xFF << 8)) >> 8,
        data.length & (0xFF),
    ]

    bytes.push(...dataLength)

    for(let box of data) {
        bytes.push(box.x)
        bytes.push(box.y)

        bytes.push(box.light.r)
        bytes.push(box.light.g)
        bytes.push(box.light.b)

        bytes.push(box.dark.r)
        bytes.push(box.dark.g)
        bytes.push(box.dark.b)

        for(let pixel of box.data) {
            bytes.push(pixel.index)
        }
    }

    return Uint8Array.from(bytes)
}

function deserialiseIntoPacked(bytes) {
    let header = bytes.slice(0, 16)

    let magic = header.slice(0, 8)
    let version = header.slice(8, 10)

    if(!magic.every((item, index) => {
        return MAGIC[index] == item
    })) {
        console.error('incorrect filetype, expecting .qimg file')
        process.exit()
    }

    console.log(chalk.blue(`file version: ${ version.join('.') }`))

    let boxSize = header[10]

    let size = {
        width: header[11],
        height: header[12],
    }

    let dataLength = (header[13] << 16)
        | (header[14] << 8)
        | header[15]

    let rest = bytes.slice(16)

    // 1 byte x, 1 byte y, 3 bytes light colour rgb, 3 bytes dark colour rgb
    let boxBytesSize = 2 + 3 + 3 + (boxSize ** 2)
    let data = []

    for(let i = 0; i < dataLength; i++) {
        let index = boxBytesSize * i

        let boxBytes = rest.slice(index, index + boxBytesSize)

        let pixelBytes = boxBytes.slice(8)
        let pixels = []

        for(let y = 0; y < boxSize; y++) {
            for(let x = 0; x < boxSize; x++) {
                let index = (y * boxSize) + x

                let pixel = {
                    x,
                    y,
                    index: pixelBytes[index]
                }

                pixels.push(pixel)
            }
        }

        let box = {
            x: boxBytes[0],
            y: boxBytes[1],
            light: {
                r: boxBytes[2],
                g: boxBytes[3],
                b: boxBytes[4],
            },
            dark: {
                r: boxBytes[5],
                g: boxBytes[6],
                b: boxBytes[7],
            },
            data: pixels,
        }

        data.push(box)
    }

    return {
        size,
        boxSize,
        data,
    }
}

async function compress(input, output, boxSize) {
    if(!boxSize) {
        console.error('no box size parameter provided')
        process.exit()
    }

    let jpegEncoders = { decode: PImage.decodeJPEGFromStream, encode: PImage.encodeJPEGToStream }
    let pngEncoders = { decode: PImage.decodePNGFromStream, encode: PImage.encodePNGToStream }

    let fileHandlers = {
        '.jpeg': jpegEncoders,
        '.jpg': jpegEncoders,
        '.png': pngEncoders,
    }

    let extension = path.extname(input)

    if(!Object.keys(fileHandlers).includes(extension)) {
        console.error(`cannot compress file of type: ${ extension }`)
        process.exit()
    }

    let stream = fs.createReadStream(path.resolve(path.join('./', input)))
    let streamDecodeHandler = fileHandlers[extension].decode

    let image = await streamDecodeHandler(stream)

    if(image.width % boxSize != 0 || image.height % boxSize != 0) {
        console.warn(chalk.yellow(`image size ${ image.width }×${ image.height } is not equally dividable by box size ${ boxSize }, some cropping will occur`))
    }

    let width = image.width - (image.width % boxSize)
    let height = image.height - (image.height % boxSize)

    let boxes = boxify(image, boxSize)
    let packed = pack(boxes)
    
    let outputPath = output 
        ? path.resolve(path.join('./', output))
        : generateOutputPath(input, 'qimg')

    let outputExtension = path.extname(outputPath)

    if(outputExtension == '.qimg') {
        let bytes = serialiseFromPacked(packed)

        await fsp.writeFile(outputPath, bytes)
        console.log(chalk.blue(`wrote file to ${ outputPath }`))
    } else {
        let streamEncodeHandler = fileHandlers[outputExtension].encode
        if(!streamEncodeHandler) {
            console.error(`cannot save as filetype ${ outputExtension }`)
            process.exit()
        }

        let canvas = PImage.make(width, height)
        let context = canvas.getContext('2d')

        let unpacked = unpack(packed)

        context.putImageData(unpacked, 0, 0, unpacked.width, unpacked.height)

        await streamEncodeHandler(canvas, fs.createWriteStream(outputPath), 100)
        console.log(chalk.blue(`wrote file to ${ outputPath }`))
    }
}

async function decompress(input, output) {
    let jpegEncoders = { decode: PImage.decodeJPEGFromStream, encode: PImage.encodeJPEGToStream }
    let pngEncoders = { decode: PImage.decodePNGFromStream, encode: PImage.encodePNGToStream }

    let fileHandlers = {
        '.jpeg': jpegEncoders,
        '.jpg': jpegEncoders,
        '.png': pngEncoders,
    }

    let outputPath = output 
        ? path.resolve(path.join('./', output))
        : generateOutputPath(input, 'jpeg')

    let outputExtension = path.extname(outputPath)

    let streamEncodeHandler = fileHandlers[outputExtension].encode
    if(!streamEncodeHandler) {
        console.error(`cannot save as filetype ${ outputExtension }`)
        process.exit()
    }

    let bytes = Uint8Array.from(await fsp.readFile(input))
    let packed = deserialiseIntoPacked(bytes)
    let unpacked = unpack(packed)

    let canvas = PImage.make(unpacked.width, unpacked.height)
    let context = canvas.getContext('2d')

    // console.log(packed)

    context.putImageData(unpacked, 0, 0, unpacked.width, unpacked.height)
    await streamEncodeHandler(canvas, fs.createWriteStream(outputPath), 100)
    console.log(chalk.blue(`wrote file to ${ outputPath }`))
}

/* -------------------------------------------------------------------------- */

program
    .name('qimg-convert')
    .description('CLI to convert between .qimg format and other image formats')

program
    .requiredOption('-i, --input <file>')
    .addOption(new Option('-n, --box-size <number>').argParser(parseInt))
    .option('-o, --output <file>')
    .parse()

let options = program.opts()

let mode = path.extname(options.input) == '.qimg' ? 'decompress' : 'compress'

if(mode == 'compress') {
    await compress(options.input, options.output, options.boxSize)
} else {
    await decompress(options.input, options.output)
}