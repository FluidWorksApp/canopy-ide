let wasm;

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedUint16ArrayMemory0 = null;

function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_export_0.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

let cachedUint32ArrayMemory0 = null;

function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

const TerminalFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_terminal_free(ptr >>> 0, 1));
/**
 * One terminal screen. Feed it PTY output, read the screen back.
 */
export class Terminal {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Terminal.prototype);
        obj.__wbg_ptr = ptr;
        TerminalFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TerminalFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_terminal_free(ptr, 0);
    }
    /**
     * The bytes a key event sends to the program under its current modes
     * (cursor and keypad application modes, kitty keyboard flags); empty
     * when the event sends nothing.
     *
     * `key` is a single character (the unshifted character of the key) or a
     * name: `Escape`, `Enter`, `Tab`, `Backspace`, `Insert`, `Delete`,
     * `Left`, `Right`, `Up`, `Down`, `PageUp`, `PageDown`, `Home`, `End`,
     * `CapsLock`, `ScrollLock`, `NumLock`, `PrintScreen`, `Pause`, `Menu`,
     * `F1`..`F35`, `Kp<name>` for the keypad (`Kp0`..`Kp9`, `KpDecimal`,
     * `KpDivide`, `KpMultiply`, `KpSubtract`, `KpAdd`, `KpEnter`, `KpEqual`)
     * and `Mod<name>` for a modifier key (`ModLeftShift`...). An unknown
     * name sends nothing.
     *
     * `kind`: 0 press, 1 repeat, 2 release. `mods`: shift 1, alt 2, ctrl 4,
     * super 8, caps lock 64, num lock 128. `text` is what the key types
     * (empty for none); `shifted` and `base` are the kitty alternates as
     * code points (0 for none).
     * @param {string} key
     * @param {number} mods
     * @param {number} kind
     * @param {string} text
     * @param {number} shifted
     * @param {number} base
     * @returns {Uint8Array}
     */
    encode_key(key, mods, kind, text, shifted, base) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.terminal_encode_key(this.__wbg_ptr, ptr0, len0, mods, kind, ptr1, len1, shifted, base);
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * @param {number} since
     * @returns {boolean}
     */
    damage_full(since) {
        const ret = wasm.terminal_damage_full(this.__wbg_ptr, since);
        return ret !== 0;
    }
    /**
     * Rows changed since frame `since`, as `[first, last, first, last, ...]`
     * inclusive; empty and `damage_full()` true when everything changed.
     * @param {number} since
     * @returns {Uint16Array}
     */
    damage_rows(since) {
        const ret = wasm.terminal_damage_rows(this.__wbg_ptr, since);
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * Bell, OSC 52 and OSC 133 events since the last call, as JSON.
     * @returns {string}
     */
    take_events() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.terminal_take_events(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The focus report (`CSI I` / `CSI O`); empty unless the program asked
     * for focus events.
     * @param {boolean} focused
     * @returns {Uint8Array}
     */
    encode_focus(focused) {
        const ret = wasm.terminal_encode_focus(this.__wbg_ptr, focused);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The report a mouse event sends under the program's mouse mode and
     * encoding; empty when the mode does not report it.
     *
     * `kind`: 0 press (or one wheel step), 1 release, 2 motion. `button`: 0
     * left, 1 middle, 2 right, 3 none (motion only), 4 wheel up, 5 wheel
     * down, 6 wheel left, 7 wheel right, 8 back, 9 forward. `col` and `row`
     * are 0-based cells.
     * @param {number} kind
     * @param {number} button
     * @param {number} col
     * @param {number} row
     * @param {number} mods
     * @returns {Uint8Array}
     */
    encode_mouse(kind, button, col, row, mods) {
        const ret = wasm.terminal_encode_mouse(this.__wbg_ptr, kind, button, col, row, mods);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * A paste as the program should receive it: bracketed when it asked for
     * that, newlines as Enter otherwise. `strip_controls` removes control
     * characters (ESC included) so pasted text can neither end the bracket
     * early nor type key sequences.
     * @param {string} text
     * @param {boolean} strip_controls
     * @returns {Uint8Array}
     */
    encode_paste(text, strip_controls) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.terminal_encode_paste(this.__wbg_ptr, ptr0, len0, strip_controls);
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * The OSC 8 link target on a visible cell.
     * @param {number} row
     * @param {number} col
     * @returns {string | undefined}
     */
    hyperlink_at(row, col) {
        const ret = wasm.terminal_hyperlink_at(this.__wbg_ptr, row, col);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Answers the program asked for (device attributes, cursor position,
     * colour queries...), to be written back to the PTY. Drain after every
     * `advance`.
     * @returns {Uint8Array}
     */
    take_replies() {
        const ret = wasm.terminal_take_replies(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    scrollback_len() {
        const ret = wasm.terminal_scrollback_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The scrollback lines' text, one string per line.
     * @param {number} start
     * @param {number} count
     * @returns {string[]}
     */
    scrollback_text(start, count) {
        const ret = wasm.terminal_scrollback_text(this.__wbg_ptr, start, count);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `count` scrollback lines from `start` (0 is the oldest), packed, each
     * padded or cut to the current width. Clusters come from
     * [`Terminal::scrollback_clusters`] with the same arguments.
     * @param {number} start
     * @param {number} count
     * @returns {Uint32Array}
     */
    scrollback_cells(start, count) {
        const ret = wasm.terminal_scrollback_cells(this.__wbg_ptr, start, count);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Default fg, bg and cursor as 0xRRGGBB (negative: unset), for answering
     * OSC 10/11/12 queries.
     * @param {number} fg
     * @param {number} bg
     * @param {number} cursor
     */
    set_reply_colors(fg, bg, cursor) {
        wasm.terminal_set_reply_colors(this.__wbg_ptr, fg, bg, cursor);
    }
    /**
     * Cluster texts of each scrollback line, flattened as `[line0 count,
     * ...line0 clusters, line1 count, ...]` (index 0 of each line included).
     * @param {number} start
     * @param {number} count
     * @returns {string[]}
     */
    scrollback_clusters(start, count) {
        const ret = wasm.terminal_scrollback_clusters(this.__wbg_ptr, start, count);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The 16 ANSI colours as 0xRRGGBB, for answering OSC 4 queries.
     * @param {Uint32Array} colors
     */
    set_default_palette(colors) {
        const ptr0 = passArray32ToWasm0(colors, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.terminal_set_default_palette(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {number} cols
     * @param {number} rows
     * @param {number} scrollback
     */
    constructor(cols, rows, scrollback) {
        const ret = wasm.terminal_new(cols, rows, scrollback);
        this.__wbg_ptr = ret >>> 0;
        TerminalFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    cols() {
        const ret = wasm.terminal_cols(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    rows() {
        const ret = wasm.terminal_rows(this.__wbg_ptr);
        return ret;
    }
    /**
     * Visible screen as text (rows joined with `\n`).
     * @returns {string}
     */
    text() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.terminal_text(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The visible grid, packed (see the crate docs).
     * @returns {Uint32Array}
     */
    cells() {
        const ret = wasm.terminal_cells(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `[mouse (0 off, 1 press, 2 normal, 3 drag, 4 any), encoding (0 default,
     * 1 utf8, 2 sgr), bracketed_paste, app_cursor_keys, app_keypad,
     * focus_events, sync_output, kitty_keyboard, alt_screen]`.
     * @returns {Uint32Array}
     */
    modes() {
        const ret = wasm.terminal_modes(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string | undefined}
     */
    title() {
        const ret = wasm.terminal_title(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * `[row, col, shape (0 block, 1 underline, 2 bar), visible, blinking]`.
     * @returns {Uint32Array}
     */
    cursor() {
        const ret = wasm.terminal_cursor(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * See [`digest`].
     * @returns {string}
     */
    digest() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.terminal_digest(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        wasm.terminal_resize(this.__wbg_ptr, cols, rows);
    }
    /**
     * Feed PTY output. Any split of the same stream gives the same screen.
     * @param {Uint8Array} bytes
     */
    advance(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.terminal_advance(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Read the current screen into this handle. Returns its sequence number;
     * the getters below describe this frame until the next `refresh`.
     * @returns {number}
     */
    refresh() {
        const ret = wasm.terminal_refresh(this.__wbg_ptr);
        return ret;
    }
    /**
     * A screen brought to the state of a [`Terminal::snapshot`].
     * @param {number} cols
     * @param {number} rows
     * @param {Uint8Array} snapshot
     * @returns {Terminal}
     */
    static restore(cols, rows, snapshot) {
        const ptr0 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.terminal_restore(cols, rows, ptr0, len0);
        return Terminal.__wrap(ret);
    }
    /**
     * Cluster texts; index 0 is unused.
     * @returns {string[]}
     */
    clusters() {
        const ret = wasm.terminal_clusters(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Escape sequences that bring a fresh screen to this one's visible state.
     * @returns {Uint8Array}
     */
    snapshot() {
        const ret = wasm.terminal_snapshot(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('canopy_term_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
