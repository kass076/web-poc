// 캐럿/Range 관련 순수 유틸

// 좌표 → 텍스트 캐럿 위치(Range)
// caretPositionFromPoint 미지원 브라우저는 caretRangeFromPoint로 fallback
export function rangeFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        return range;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
}

// 요소 내용의 맨 끝을 가리키는 Range
export function rangeAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    return range;
}

// 캐럿을 node 바로 뒤로 이동
export function placeCaretAfter(node) {
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}
