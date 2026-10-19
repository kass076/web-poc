import { rangeFromPoint, rangeAtEnd, placeCaretAfter } from './caret.js';

const DEFAULTS = {
    container: '.draggable-container', // 셀렉터 또는 엘리먼트
    editor: '.template-box',           // contenteditable 엘리먼트
    itemSelector: '.draggable-item',
    deleteSelector: '.delete',
    classNames: { dragging: 'dragging', hidden: 'hidden', preview: 'drop-preview' }, // Draggable 상태, 숨김, 드롭 미리보기용 클래스 CSS customize 혹은 클래스 변경 필요할 때
    copyFromContainer: true,           // container → editor: true면 복제, false면 이동
    clickToInsert: true,               // container 아이템 클릭 시 editor 커서 위치에 복제 삽입
    removeOnReturn: true,              // editor → container: true면 삭제, false면 container로 이동
    onChange: null,                    // ({ type, item }) => void  (type: insert | move | remove | reorder)
};

const resolve = target => typeof target === 'string' ? document.querySelector(target) : target;

export class TemplateDnD {
    #opts;
    #cls;
    #container;
    #editor;
    #abort = new AbortController();
    #observer;

    // 드래그 상태
    #draggedEl = null;
    #preview = null;
    #fromContainer = false;
    #copy = false; // 이번 드래그를 editor에 놓으면 복제할지

    // 다른 곳을 클릭하면 editor의 selection이 사라지므로 마지막 커서 위치를 기억해 둠
    #lastRange = null;

    constructor(options = {}) {
        this.#opts = { ...DEFAULTS, ...options, classNames: { ...DEFAULTS.classNames, ...options.classNames } };
        this.#cls = this.#opts.classNames;
        this.#container = resolve(this.#opts.container);
        this.#editor = resolve(this.#opts.editor);
        if (!this.#container || !this.#editor) {
            throw new Error('TemplateDnD: container 또는 editor를 찾을 수 없습니다.');
        }

        this.#makeDraggable();
        // 나중에 container에 추가되는 아이템도 드래그 가능하게
        this.#observer = new MutationObserver(() => this.#makeDraggable());
        this.#observer.observe(this.#container, { childList: true, subtree: true });

        this.#bindEvents();
    }

    // ---- 공개 API ----

    // item(엘리먼트)을 복제해 editor의 마지막 커서 위치에 삽입
    insertAtCursor(item) {
        let range = this.#lastRange;
        if (!range || !this.#editor.contains(range.startContainer)) range = rangeAtEnd(this.#editor); // 커서가 없으면 맨 끝
        range.deleteContents(); // 선택된 텍스트가 있으면 대체

        const clone = this.#cloneItem(item);
        clone.contentEditable = 'false';
        range.insertNode(clone);

        // 커서를 삽입한 아이템 뒤로 이동
        this.#editor.focus();
        placeCaretAfter(clone);
        this.#emit('insert', clone);
        return clone;
    }

    // editor 안의 아이템 목록 (순서대로)
    getItems() {
        return [...this.#editor.querySelectorAll(this.#opts.itemSelector)]
            .filter(el => !el.classList.contains(this.#cls.preview))
            .map(element => ({ key: element.dataset.key, element }));
    }

    // editor 내용을 복사해 각 아이템을 replacer(item)의 결과(문자열 또는 Node)로 바꾼 DocumentFragment 반환
    serialize(replacer) {
        const copy = this.#editor.cloneNode(true); // 원본은 그대로 두고 복사본에서 치환
        copy.querySelectorAll(`.${this.#cls.preview}`).forEach(el => el.remove());
        copy.querySelectorAll(this.#opts.itemSelector).forEach(item => {
            const value = replacer(item);
            item.replaceWith(value instanceof Node ? value : String(value ?? ''));
        });

        const fragment = document.createDocumentFragment();
        fragment.append(...copy.childNodes); // 줄바꿈(<div>, <br>) 구조 유지
        return fragment;
    }

    clear() {
        this.#editor.replaceChildren();
        this.#lastRange = null;
    }

    destroy() {
        this.#cleanup();
        this.#abort.abort();
        this.#observer.disconnect();
    }

    // ---- 이벤트 ----

    #bindEvents() {
        const on = (target, type, handler) => target.addEventListener(type, handler, { signal: this.#abort.signal });
        const container = this.#container;
        const editor = this.#editor;

        // 드래그 시작/종료 (container, editor 양쪽 아이템 모두)
        for (const root of [container, editor]) {
            on(root, 'dragstart', e => this.#onDragStart(e, root));
            on(root, 'dragend', () => this.#cleanup());
        }

        // 드롭 영역 밖으로 나가면 미리보기 제거 (원래 자리 그대로 보이게)
        on(document, 'dragover', e => {
            if (this.#draggedEl && !editor.contains(e.target) && !container.contains(e.target)) this.#clearPreview();
        });

        on(document, 'selectionchange', () => {
            const sel = window.getSelection();
            if (sel.rangeCount && editor.contains(sel.anchorNode)) this.#lastRange = sel.getRangeAt(0).cloneRange();
        });

        on(editor, 'dragover', e => this.#onEditorDragOver(e));
        on(editor, 'drop', e => this.#onEditorDrop(e));
        on(container, 'dragover', e => this.#onContainerDragOver(e));
        on(container, 'drop', e => this.#onContainerDrop(e));

        if (this.#opts.clickToInsert) {
            on(container, 'click', e => {
                const item = this.#closestItem(e.target, container);
                if (item) this.insertAtCursor(item);
            });
        }

        // 삭제: editor 안 아이템의 delete 버튼 클릭
        on(editor, 'click', e => {
            const btn = e.target.closest(this.#opts.deleteSelector);
            const item = btn && this.#closestItem(btn, editor);
            if (!item) return;
            e.preventDefault();
            item.remove();
            editor.normalize();
            this.#emit('remove', item);
        });
    }

    #onDragStart(e, root) {
        const item = this.#closestItem(e.target, root);
        if (!item) return; // 일반 텍스트 드래그는 브라우저 기본 동작
        this.#draggedEl = item;
        this.#fromContainer = root === this.#container;
        this.#copy = this.#fromContainer && this.#opts.copyFromContainer;
        this.#preview = this.#createPreview(item);
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', ''); // Firefox는 setData가 있어야 드래그 시작
        requestAnimationFrame(() => item.classList.add(this.#cls.dragging));
    }

    #onEditorDragOver(e) {
        if (!this.#draggedEl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = this.#copy ? 'copy' : 'move';
        if (e.target === this.#preview) return; // 미리보기 위에서는 위치 유지 (깜빡임 방지)
        this.#showPreview(el => this.#getDropRange(e).insertNode(el), !this.#copy);
    }

    #onEditorDrop(e) {
        if (!this.#draggedEl) return;
        if (!this.#preview.isConnected) this.#showPreview(el => this.#getDropRange(e).insertNode(el), !this.#copy);
        const fromContainer = this.#fromContainer;
        const dropped = this.#copy ? this.#cloneItem(this.#draggedEl) : this.#draggedEl;
        dropped.contentEditable = 'false'; // 아이템 내부 텍스트가 편집되지 않도록
        this.#drop(e, dropped);
        placeCaretAfter(dropped); // 캐럿을 드랍한 아이템 뒤로 이동
        this.#emit(fromContainer ? 'insert' : 'move', dropped);
    }

    #onContainerDragOver(e) {
        if (!this.#draggedEl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (e.target === this.#preview) return;
        if (this.#fromContainer || !this.#opts.removeOnReturn) {
            this.#showPreview(el => this.#container.insertBefore(el, this.#getContainerRef(e)));
        } else {
            this.#showPreview(null); // editor의 아이템은 container에 넣지 않고 제거
        }
    }

    #onContainerDrop(e) {
        if (!this.#draggedEl) return;
        e.preventDefault();
        const item = this.#draggedEl;

        if (!this.#fromContainer && this.#opts.removeOnReturn) {
            item.remove();
            this.#cleanup();
            this.#editor.normalize();
            this.#emit('remove', item);
            return;
        }

        if (!this.#preview.isConnected) this.#showPreview(el => this.#container.insertBefore(el, this.#getContainerRef(e)));
        const fromContainer = this.#fromContainer;
        item.removeAttribute('contenteditable');
        this.#drop(e, item);
        this.#emit(fromContainer ? 'reorder' : 'remove', item);
    }

    // ---- 드롭 위치 계산 ----

    // editor 안에서 드랍할 위치 계산 (미리보기를 뺀 레이아웃 기준)
    #getDropRange(e) {
        const range = rangeFromPoint(e.clientX, e.clientY);
        if (!range || !this.#editor.contains(range.startContainer)) return rangeAtEnd(this.#editor); // 텍스트 밖이면 맨 끝

        // 다른 아이템 위라면 그 아이템의 앞/뒤로
        const node = range.startContainer;
        const item = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest(this.#opts.itemSelector);
        if (item && this.#editor.contains(item)) {
            const rect = item.getBoundingClientRect();
            const before = e.clientX < rect.left + rect.width / 2;
            before ? range.setStartBefore(item) : range.setStartAfter(item);
            range.collapse(true);
        }
        return range;
    }

    // container 안에서 끼워 넣을 기준 아이템 계산
    #getContainerRef(e) {
        const items = [...this.#container.querySelectorAll(this.#opts.itemSelector)]
            .filter(el => !el.classList.contains(this.#cls.dragging) && !el.classList.contains(this.#cls.preview));
        return items.find(item => {
            const rect = item.getBoundingClientRect();
            const sameRow = e.clientY >= rect.top && e.clientY <= rect.bottom;
            const leftHalf = e.clientX < rect.left + rect.width / 2;
            return (sameRow && leftHalf) || e.clientY < rect.top;
        }) || null; // 없으면 맨 뒤에 추가
    }

    // ---- 미리보기 ----

    #createPreview(item) {
        const el = this.#cloneItem(item);
        el.classList.add(this.#cls.preview);
        el.draggable = false;
        el.contentEditable = 'false';
        return el;
    }

    // 미리보기를 빼고 최종 레이아웃(이동이면 원본 숨김, 복제면 원본 유지) 상태에서 위치를 계산한 뒤 미리보기를 끼워 넣음
    // insert가 없으면 미리보기 없이 원본만 숨김 (= 삭제될 모습)
    #showPreview(insert, hideOriginal = true) {
        this.#preview.remove();
        this.#draggedEl.classList.toggle(this.#cls.hidden, hideOriginal);
        if (insert) insert(this.#preview);
    }

    #clearPreview() {
        if (this.#preview) this.#preview.remove();
        this.#editor.normalize();
        if (this.#draggedEl) this.#draggedEl.classList.remove(this.#cls.hidden);
    }

    #drop(e, node) {
        e.preventDefault();
        this.#preview.replaceWith(node);
        this.#cleanup();
    }

    #cleanup() {
        this.#clearPreview();
        if (this.#draggedEl) this.#draggedEl.classList.remove(this.#cls.dragging);
        this.#draggedEl = null;
        this.#preview = null;
    }

    // ---- 헬퍼 ----

    #closestItem(target, root) {
        const item = target.closest?.(this.#opts.itemSelector);
        return item && root.contains(item) && !item.classList.contains(this.#cls.preview) ? item : null;
    }

    #cloneItem(item) {
        const el = item.cloneNode(true);
        el.classList.remove(this.#cls.dragging, this.#cls.hidden);
        return el;
    }

    #makeDraggable() {
        this.#container.querySelectorAll(this.#opts.itemSelector).forEach(el => {
            if (!el.draggable && !el.classList.contains(this.#cls.preview)) el.draggable = true;
        });
    }

    #emit(type, item) {
        this.#opts.onChange?.({ type, item });
        this.#editor.dispatchEvent(new CustomEvent('templatednd:change', { detail: { type, item } }));
    }
}
