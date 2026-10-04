// SoundFont 2 parser
const Sf2 = (function () {
    const PRESET_RECORD_SIZE = 38;

    function readText(view, offset, length) {
        let text = '';

        for (let i = 0; i < length; i += 1) {
            const code = view.getUint8(offset + i);

            if (code === 0) break;

            text += String.fromCharCode(code);
        }

        return text.trim();
    }

    function readChunks(view, start, end) {
        const chunks = [];
        let offset = start;

        while (offset + 8 <= end) {
            const size = view.getUint32(offset + 4, true);
            const dataEnd = Math.min(offset + 8 + size, view.byteLength);
            chunks.push({ id: readText(view, offset, 4), start: offset + 8, size: dataEnd - offset - 8, end: dataEnd });
            offset += 8 + size + (size & 1);
        }

        return chunks;
    }

    function findList(view, chunks, type) {
        return chunks.find(function (chunk) { return chunk.id === 'LIST' && readText(view, chunk.start, 4) === type; });
    }

    function readPresets(view, phdr) {
        return Array.from({ length: Math.max(Math.floor(phdr.size / PRESET_RECORD_SIZE) - 1, 0) }, function (_, index) {
            const offset = phdr.start + index * PRESET_RECORD_SIZE;
            return {
                name: readText(view, offset, 20),
                program: view.getUint16(offset + 20, true),
                bank: view.getUint16(offset + 22, true)
            };
        });
    }

    function parse(buffer) {
        const view = new DataView(buffer);

        if (view.byteLength < 12 || readText(view, 0, 4) !== 'RIFF' || readText(view, 8, 4) !== 'sfbk') {
            throw new Error('invalidSf2');
        }

        const top = readChunks(view, 12, view.byteLength);
        const pdta = findList(view, top, 'pdta');
        const phdr = pdta && readChunks(view, pdta.start + 4, pdta.end).find(function (chunk) { return chunk.id === 'phdr'; });

        if (!phdr) throw new Error('invalidSf2');

        const info = findList(view, top, 'INFO');
        const inam = info && readChunks(view, info.start + 4, info.end).find(function (chunk) { return chunk.id === 'INAM'; });

        return { name: inam ? readText(view, inam.start, inam.size) : '', presets: readPresets(view, phdr) };
    }

    return { parse };
}());

// Domino module rewriter
const Domino = (function () {
    const PERCUSSION_BANK = 128;
    const EOL = '\r\n';

    function bytesToText(bytes) {
        const parts = [];

        for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
        return parts.join('');
    }

    function textToBytes(text) {
        return Uint8Array.from(text, function (char) { return char.charCodeAt(0); });
    }

    function escapeName(name) {
        return name
            .replace(/[^\x20-\x7e]/g, '?')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function pad3(value) {
        return String(value).padStart(3, ' ');
    }

    function bankValues(bank) {
        return bank <= 127 ? { msb: bank, lsb: 0 } : { msb: (bank >> 7) & 127, lsb: bank & 127 };
    }

    function groupByProgram(presets) {
        return presets.reduce(function (groups, preset) {
            return { ...groups, [preset.program]: [...(groups[preset.program] || []), preset] };
        }, {});
    }

    function bankLine(preset, isDrum, tones) {
        const name = escapeName(preset.name);

        if (isDrum) return tones ? [`<Bank Name="${name}" >`, ...tones, '</Bank>'].join(EOL) : `<Bank Name="${name}" />`;

        const { msb, lsb } = bankValues(preset.bank);

        return `<Bank Name="${name}" MSB="${pad3(msb)}" LSB="${pad3(lsb)}" />`;
    }

    function pcBlock(program, presets, isDrum, toneTable) {
        const sorted = [...presets].sort(function (a, b) { return a.bank - b.bank; });

        return [
            `<PC Name="${escapeName(sorted[0].name)}" PC="${pad3(program + 1)}">`,
            ...sorted.map(function (preset) { return bankLine(preset, isDrum, toneTable[program]); }),
            '</PC>'
        ].join(EOL);
    }

    function mapBlock(mapName, presets, isDrum, toneTable = {}) {
        const groups = groupByProgram(presets);
        const programs = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });

        return [`<Map Name="${escapeName(mapName)}">`, ...programs.map(function (program) { return pcBlock(program, groups[program], isDrum, toneTable); }), '</Map>']
            .join(EOL + EOL);
    }

    function replaceSection(text, tag, inner) {
        return text.replace(new RegExp(`(<${tag}>)[\\s\\S]*?(</${tag}>)`, 'i'), function (match, open, close) {
            return `${open}${EOL}${EOL}${inner}${EOL}${EOL}${close}`;
        });
    }

    const TOOL_NAME = 'Sf2Conv';
    const CREATOR_TAG = `(+ ${TOOL_NAME})`;

    function readTag(tag, attr) {
        const match = tag.match(new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));

        return match ? (match[1] !== undefined ? match[1] : match[2]) : null;
    }

    function writeTag(tag, attr, value) {
        const pattern = new RegExp(`(\\s${attr}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, 'i');

        return pattern.test(tag)
            ? tag.replace(pattern, function (match, prefix) { return `${prefix}"${value}"`; })
            : tag.replace(/\s*\/?>$/, function (end) { return ` ${attr}="${value}"${end}`; });
    }

    function withCreatorTag(creator) {
        return creator === null || creator.trim() === '' ? TOOL_NAME : creator.includes(CREATOR_TAG) ? creator : `${creator} ${CREATOR_TAG}`;
    }

    function updateModuleTag(text, moduleName) {
        return text.replace(/<ModuleData\b[^>]*>/i, function (tag) {
            return writeTag(writeTag(tag, 'Name', escapeName(moduleName)), 'FileCreator', withCreatorTag(readTag(tag, 'FileCreator')));
        });
    }

    function toneTableFromBase(text) {
        const section = text.match(/<DrumSetList>[\s\S]*?<\/DrumSetList>/i);
        const blocks = section ? [...section[0].matchAll(/<PC\s[^>]*?\bPC\s*=\s*"\s*(\d+)\s*"[^>]*>([\s\S]*?)<\/PC>/gi)] : [];

        return blocks.reduce(function (table, [, number, body]) {
            const program = Number(number) - 1;
            const tones = body.match(/<Tone\b[^>]*\/>/gi) || [];
            return table[program] || tones.length === 0 ? table : { ...table, [program]: tones };
        }, {});
    }

    function convert(baseBytes, soundFont, { name, reuseNames }) {
        const text = bytesToText(baseBytes);

        if (!/<ModuleData[\s>]/i.test(text) || !/<InstrumentList>/i.test(text)) throw new Error('invalidBase');

        const valid = soundFont.presets.filter(function (preset) { return preset.program < 128; });
        const melodic = valid.filter(function (preset) { return preset.bank !== PERCUSSION_BANK; });
        const drums = valid.filter(function (preset) { return preset.bank === PERCUSSION_BANK; });

        if (valid.length === 0) throw new Error('noPresets');

        const toneTable = reuseNames ? toneTableFromBase(text) : {};
        const withModule = updateModuleTag(text, name);
        const withInstruments = melodic.length
            ? replaceSection(withModule, 'InstrumentList', mapBlock(name, melodic, false))
            : withModule;
        const withDrums = drums.length
            ? replaceSection(withInstruments, 'DrumSetList', mapBlock(`${name} Percussion`, drums, true, toneTable))
            : withInstruments;

        return textToBytes(withDrums);
    }

    return { convert };
}());

// Translations
const TRANSLATIONS = {
    en: {
        title: '.SF2 to Domino Module File Converter',
        step1: 'Select a base Domino module file (e.g. GM2, GS, XG template)',
        step2: 'Select a SoundFont2 (.sf2) file',
        step3: 'Convert and download the module file',
        convert: 'Convert',
        reuseNames: 'Reuse drum key names from the base file (matched by program number)',
        close: 'Close',
        aboutTitle: 'About',
        aboutBody:
            '<p>Sf2XmlConv builds a Domino module from a base module file plus a SoundFont2 (.sf2). Only the patch lists are replaced, so all other features of the base module are kept.</p>' +
            '<p class="mb-0">Redistributing the results of the conversion without the original creators’ permission is not allowed.</p>',
        errNoFiles: 'Please select both files.',
        invalidSf2: 'The selected file is not a valid SoundFont2 file.',
        invalidBase: 'The selected base file is not a valid Domino module file.',
        noPresets: 'No presets were found in the SoundFont2.',
        unknown: 'Conversion failed.',
        done: function (count) { return `Done. ${count} presets written.`; }
    },
    jp: {
        title: '.SF2 → Domino音源定義ファイル コンバーター',
        step1: 'ベースとなるDomino音源定義ファイルを選択（GM2、GS、XGなど）',
        step2: 'SoundFont2（.sf2）ファイルを選択',
        step3: '変換して音源定義ファイルをダウンロード',
        convert: '変換',
        reuseNames: 'ドラムのキー名をベースファイルから引き継ぐ（プログラム番号で照合）',
        close: '閉じる',
        aboutTitle: 'このツールについて',
        aboutBody:
            '<p>Sf2XmlConv は、ベースとなる音源定義ファイルと SoundFont2（.sf2）から Domino の音源定義ファイルを作成します。置き換えるのは音色リストのみなので、ベースファイルの他の機能はそのまま引き継がれます。</p>' +
            '<p class="mb-0">変換した成果物を元の作者の許可なく再配布することは禁止です。</p>',
        errNoFiles: '両方のファイルを選択してください。',
        invalidSf2: '選択されたファイルは有効な SoundFont2 ファイルではありません。',
        invalidBase: '選択されたベースファイルは有効な Domino 音源定義ファイルではありません。',
        noPresets: 'SoundFont2 に音色が見つかりませんでした。',
        unknown: '変換に失敗しました。',
        done: function (count) { return `完了しました。${count} 個の音色を出力しました。`; }
    }
};

// State and pure helpers
const initialState = { lang: 'en', status: null };

function translate(lang, key) {
    return TRANSLATIONS[lang][key];
}

function statusHtml(lang, status) {
    if (!status) return '';

    const message = typeof TRANSLATIONS[lang][status.key] === 'function'
        ? TRANSLATIONS[lang][status.key](status.arg)
        : translate(lang, status.key);

    return `<div class="alert alert-${status.type} py-2 mb-0">${message}</div>`;
}

function baseName(fileName) {
    return fileName.replace(/\.[^.]+$/, '');
}

// File and download helpers
async function readBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
}

function downloadBytes(bytes, fileName) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/xml' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: fileName });

    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

async function runConversion(baseFile, sf2File, reuseNames) {
    const soundFont = Sf2.parse((await readBytes(sf2File)).buffer);
    const output = Domino.convert(await readBytes(baseFile), soundFont, {
        name: soundFont.name || baseName(sf2File.name),
        reuseNames
    });

    return { output, count: soundFont.presets.length, fileName: `${baseName(sf2File.name)}.xml` };
}

// UI rendering
function render(state) {
    document.documentElement.lang = state.lang === 'jp' ? 'ja' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = translate(state.lang, el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = translate(state.lang, el.dataset.i18nHtml); });
    
    const statusElement = document.getElementById('status');
    const appendError = Boolean(state.status && (state.status.details || state.status.type === 'warning'));
    
    statusElement.innerHTML = statusHtml(state.lang, state.status);
    statusElement.closest('.step').classList.toggle('has-error', appendError);

    if (appendError) {
        const details = document.createElement('textarea');
        details.className = 'form-control status-error mt-2';
        details.readOnly = true;
        details.setAttribute('aria-label', 'Error details');
        details.value = state.status.details || translate(state.lang, state.status.key);
        statusElement.appendChild(details);
        details.style.height = 'auto';
        details.style.height = `${details.scrollHeight}px`;
    }
}

// UI event handlers
function init() {
    let state = initialState;
    function update(patch) { state = { ...state, ...patch }; render(state); }

    TopBar.mount(document.getElementById('top-bar'), {
        languages: ['en', 'jp'],
        active: state.lang,
        onLanguage: function (lang) { update({ lang }); }
    });

    const baseInput = document.getElementById('baseFile');
    const sf2Input = document.getElementById('sf2File');
    const button = document.getElementById('convertBtn');

    button.addEventListener('click', async function () {
        const baseFile = baseInput.files[0];
        const sf2File = sf2Input.files[0];

        if (!baseFile || !sf2File) return update({ status: { key: 'errNoFiles', type: 'warning' } });

        button.disabled = true;

        try {
            const { output, count, fileName } = await runConversion(baseFile, sf2File, document.getElementById('reuseNames').checked);

            downloadBytes(output, fileName);
            update({ status: { key: 'done', arg: count, type: 'success' } });
        } catch (error) {
            const known = error && TRANSLATIONS.en[error.message] && typeof TRANSLATIONS.en[error.message] === 'string';

            update({ status: {
                key: known ? error.message : 'unknown',
                type: 'danger',
                details: error instanceof Error ? error.stack || error.message : String(error)
            } });
        } finally {
            button.disabled = false;
        }
    });

    render(state);
}

document.addEventListener('DOMContentLoaded', init);
