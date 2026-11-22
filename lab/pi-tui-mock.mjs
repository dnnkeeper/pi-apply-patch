// Minimal pi-tui stand-in for the renderer tests. The real package is provided by Pi at runtime;
// the repo's node_modules copy is a stub without render(). Keep this behaviour in sync with the
// parts of Text/Container/Spacer the extension uses: no wrapping, ANSI preserved verbatim.
export class Text {
	constructor(text = "", paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}
	setText(text) {
		this.text = text;
	}
	setCustomBgFn() {}
	setPaddingX(paddingX) {
		this.paddingX = paddingX;
	}
	invalidate() {}
	render() {
		const pad = " ".repeat(this.paddingX);
		const lines = this.text.split("\n").map((line) => `${pad}${line}`);
		const blank = this.paddingY > 0 ? [""] : [];
		return [...blank, ...lines, ...blank];
	}
}

export class Spacer {
	constructor(lines = 1) {
		this.lines = lines;
	}
	render() {
		return Array.from({ length: this.lines }, () => "");
	}
	invalidate() {}
}

export class Container {
	constructor() {
		this.children = [];
	}
	addChild(component) {
		this.children.push(component);
	}
	removeChild(component) {
		this.children = this.children.filter((child) => child !== component);
	}
	clear() {
		this.children = [];
	}
	invalidate() {
		for (const child of this.children) child.invalidate?.();
	}
	render(width) {
		return this.children.flatMap((child) => child.render(width));
	}
}

export class Box extends Container {
	constructor(paddingX = 1, paddingY = 1, bgFn) {
		super();
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}
	render(width) {
		const lines = super.render(Math.max(1, width - this.paddingX * 2));
		const pad = " ".repeat(this.paddingX);
		const blank = this.bgFn ? Array.from({ length: this.paddingY }, () => this.bgFn("")) : [];
		const body = lines.map((line) => (this.bgFn ? this.bgFn(`${pad}${line}`) : `${pad}${line}`));
		return [...blank, ...body, ...blank];
	}
}
