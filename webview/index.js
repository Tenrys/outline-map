/**
 * @typedef {{
 * 		id: string,
 *		level: string;
 *		message: string;
 *		range: Range;
 *}} Diagnostic
 * @typedef {{
 * 		line: number;
 * 		character: number;
 * }} Position
 * @typedef {{
 * 		start: Position;
 * 		end: Position;
 * }} Range;
 * @typedef {{
 * 		newValue: any;
 *		oldValue: any;
 *		path: string[];
 * }} Change;
 */

// import { SymbolNode } from '../src/outline';
let vscode = acquireVsCodeApi();

let outlineHTML = document.querySelector('#outline-root');

let config = {
	enableAutomaticIndentReduction: false,
	follow: 'cursor',
	depth: Infinity,
	pinStatus: 1, // 1: unpinned, 2: pinned, 3: frozen
	expandOutlineMethod: 'hover',
};


/** @type {{element: OutlineElement, children: OutlineNode[]}} */
let outlineTree;

/** 
 * all the nodes in the outline, keyed by their range
 * @type {Map<Range, OutlineNode>} 
 */
let indexes;

let activeToast;

let lastVisibleRange;

window.addEventListener('resize', ()=>{
	setTimeout(()=>{
		// async to make sure the DOM is rendered first.
		let labelHeight = outlineTree.children[0].element.label.getBoundingClientRect().height;

		outlineHTML.setAttribute('style', (outlineHTML.getAttribute('style') ?? '') + `--label-height: ${labelHeight}px;`);
	}, 100);
});

window.addEventListener('message', event => {
	let message = event.data;

	// console.log(message);
	switch (message.type){
	case 'style':
		configStyle(message.style);
		break;
	case 'config':
		config.enableAutomaticIndentReduction = message.config.enableAutomaticIndentReduction;
		config.follow = message.config.follow;
		config.depth = message.config.defaultMaxDepth;
		config.expandOutlineMethod = message.config.expandOutlineMethod;
		if(message.config.customFont !== ''){
			outlineHTML.style.fontFamily = message.config.customFont;
		}
		if(message.config.customCSS !== ''){
			let style = document.createElement('style');

			style.innerHTML = message.config.customCSS;
			document.body.appendChild(style);
		}
		break;
	case 'build':
		if(message.outline === null){
			outlineHTML.innerHTML = '<div id="missing">Symbols Not Found</div>';
			break;
		}
		outlineHTML.innerHTML = '';
		buildOutline(message.outline);
		break;
	case 'scroll':
		lastVisibleRange = message.range;
		updateVisibleRange(message.range);
		hideOverflow();
		break;
	case 'focus':
		updateFocusPosition(message.position);
		setTimeout(hideOverflow, 500);
		break;
	case 'update':
		updateOutline(message.changes);
		updateVisibleRange(lastVisibleRange);
		hideOverflow();
		break;
	case 'diagnostics':
		updateDiagnostics(message.diagnostics);
		break;
	case 'changeDepth':
		config.depth += message.deltaDepth;
		config.depth < 1 && (config.depth = 1);
		activeToast && activeToast.remove();
		activeToast = new Toast(`Depth: ${config.depth}`, 2000);
		indexes?.forEach(node=>{
			node.open = node.depth <= config.depth;
		});
		break;
	case 'pin':
		config.pinStatus = message.pinStatus;
		console.log(config.pinStatus);
		break;
	}
});

function configStyle(userStyle){
	for (const key in userStyle){
		if (Object.hasOwnProperty.call(userStyle, key)){
			const color = userStyle[key];

			style[key] = color;
		}
	}
	outlineHTML.setAttribute('style', (outlineHTML.getAttribute('style') ?? '') + `--visible-range-bgcolor: ${style.visibleRange};`);
	outlineHTML.setAttribute('style', (outlineHTML.getAttribute('style') ?? '') + `--focus-bgcolor: ${style.focusingItem};`);
}

function hideOverflow(){
	if(!config.enableAutomaticIndentReduction){
		return;
	}
	indexes?.forEach((node, itemRange)=>{
		// overflow
		if(!node.element.childrenContainer){
			return;
		}

		if(node.open && node.element.label.getBoundingClientRect().bottom < 0){
			node.element.childrenContainer?.setAttribute('hide-self', 'true');
		}
		else{
			node.element.childrenContainer?.removeAttribute('hide-self');
		}
	});
}

/**
 * Highlight the visible range of the outline
 * Expand a branch when a child node is visible.
 * @param {Range} range 
 */
function updateVisibleRange(range){
	let inRange = [];

	if(config.pinStatus === 3){
		return;
	}
	indexes?.forEach((node, itemRange)=>{
		let visible = itemRange.end.line > range.start.line && itemRange.start.line < range.end.line;

		if(config.follow !== 'cursor-always-open' && config.pinStatus === 1){
			node.open = visible;
		}
		node.highlight = itemRange.start.line > range.start.line && itemRange.start.line < range.end.line;
		if(!node.open && node.focus){
			bubblePropertyUpward(node, 'focus');
		}
		if(node.parent.children.includes(node) && !node.open && node.diagnostics.length){
			bubblePropertyUpward(node, 'diagnostics');
		}
		if(node.open && node.fromChild && node.fromChild.focus){
			node.focus = false;
		}
		if(node.open && node.diagnostics.length){
			clearPropertyUpward(node, 'diagnostics');
		}
		if(config.follow === 'viewport' && visible && node.parent.open){
			inRange.push(node);
		}
	});

	if(config.follow === 'viewport'){
		let half = Math.floor(inRange.length / 2);

		if(inRange[half]){
			scrollOutline(inRange[half]);
		}
	}
}

/**
 * Show the cursor's position on outline
 * @param {Position} position 
 */
function updateFocusPosition(position){
	if(config.pinStatus === 3){
		return;
	}
	if(!indexes){
		setTimeout(updateFocusPosition, 100, position);
		return;
	}
	let closestNode;
	let closest = Infinity;

	indexes.forEach((node, itemRange)=>{
		let diff = Math.abs(itemRange.start.line - position.line);

		if(diff < closest){
			closest = diff;
			closestNode = node;
		}
		node.focus = false;
	});

	closestNode.focus = true;
	scrollOutline(closestNode);
}

/**
 * 
 * @param {OutlineNode} reference 
 */
function scrollOutline(reference){
	if(config.pinStatus === 3){
		return;
	}
	let visibleNode = reference;

	while (visibleNode.parent && !visibleNode.parent.open){
		visibleNode = visibleNode.parent;
	}
	scrollTo({
		top: visibleNode?.element.label.offsetTop - window.innerHeight / 2,
		left: 0,
		behavior: 'smooth',
	});
}

/**
 * 
 * @param {Change[]} changes 
 */
function updateOutline(changes){
	if(config.pinned){
		return;
	}
	changes.forEach(change=>{
	// Move to the changed node
		/** @type {OutlineNode} */
		let node = outlineTree;
		let i = 0;

		for (; i < change.path.length - 1; i++){
			node = node[change.path[i]];
		}

		let property = change.path[i];

		if(node === undefined){
			return;
		}

		let oldValue = change.oldValue || node[property];

		node[property] = change.newValue;

		if(property === 'range'){
			let siblingNodes = [].concat(node.parent.children);

			siblingNodes = siblingNodes.splice(siblingNodes.indexOf(node), 1);

			let j = 0;

			for (; j < siblingNodes.length; j++){
				let hit = change.newValue.start.line > siblingNodes[j].range.start.line
						&& change.newValue.start.line < siblingNodes[j + 1].range.start.line;

				if(hit){
					break;
				}
				if(j === 0 && !hit){
					j--;
					break;
				}
			}
			if(siblingNodes[j + 1]){
				node.parent.element.childrenContainer.insertBefore(
					node.element.root,
					siblingNodes[j + 1].element.root
				);
			}
			else{
				node.parent.element.childrenContainer.appendChild(
					node.element.root
				);
			}
			indexes.delete(oldValue);
			indexes.set(change.newValue, node);
		}
	});
}

/**
 * 
 * @param {Diagnostic[]} diagnostics 
 */
function updateDiagnostics(diagnostics){
	if(config.pinned){
		return;
	}
	if(!indexes){
		setTimeout(updateDiagnostics, 300, diagnostics);
		return;
	}
	// console.log(diagnostics);
	diagnostics.forEach((diagnostic, index)=>{
		let range = diagnostic.range;
		let closest = Infinity;
		let closestNode;

		indexes.forEach((node, itemRange)=>{
			if(index === 0 && node.diagnostics.length !== 0){
				node.diagnostics = [];
			}
			let diff = Math.abs(itemRange.start.line - range.start.line);

			if(diff < closest){
				closest = diff;
				closestNode = node;
			}
		});

		closestNode.pushDiagnostics(diagnostic);
		// console.log(closestNode);
	});
}

/**
 * Bubble a property upward to its parent node when the parent is 'collapsed'
 * 
 * **Note:** It will mark `fromChild: property` on the parent node
 * 
 * **Note:** bubble will stop if the attribute value of the parent node is not a falsy value
 * @param {OutlineNode} node node starting to bubble
 * @param {string} property the name of the property to bubble
 */
function bubblePropertyUpward(node, property){
	let parent = node.parent;

	if(!parent || parent.name === undefined || parent.open || parent.fromChild?.[property] || parent.children.length === 0 || !parent.children.includes(node)){
		return;
	}
	if(!parent.fromChild){
		parent.fromChild = {};
	}
	if(!parent[property]){
		parent[property] = node[property];
		parent.fromChild[property] = true;
		bubblePropertyUpward(parent, property);
	}
	else if(parent[property] instanceof Array && node[property] instanceof Array){
		if(parent[property].length === 0){
			parent[property] = node[property];
			if(!parent.fromChild[property]){
				parent.fromChild[property] = 0;
			}
			parent.fromChild[property] += node[property].length;
			bubblePropertyUpward(parent, property);
		}
	}
}

/**
 * Clear the property bubbled by {@link bubblePropertyUpward}
 * 
 * **Note:** It will set the property value of the parent node to defaultValue
 * 			when property `fromChild` is set
 * 
 * **Note:** The defaultValue will be cloned if it's a object
 * 
 * **Note:** progress will stop when `fromChild` is unset
 * @param {OutlineNode} node node starting to clear
 * @param {string} property the name of the property to clear
 * @param {?any} defaultValue the value to set to the property
 */
function clearPropertyUpward(node, property, defaultValue){
	let parent = node.parent;

	if(!parent || parent.name === undefined || !parent.fromChild || !parent.fromChild[property]){
		return;
	}
	if(parent[property] instanceof Array && node[property] instanceof Array){
		parent[property] = [];
		clearPropertyUpward(parent, property, defaultValue);
	}
	else if(parent[property]){
		parent[property] = defaultValue;
		parent.fromChild[property] = false;
	}
}

/**
 * 
 * @param {SymbolNode} outline 
 * @param {?OutlineNode} parent
 * @param {?number} depth
 * @return {OutlineNode}
 */
function buildOutline(outline, parent, depth = 0){
	if (!parent && outline.type === 'File' && outline.name === '__root__'){
		// Create the root
		indexes = new Map();
		let root = document.createElement('div');

		root.className = 'outline-node outline-internal outline-container';
		outlineHTML.appendChild(root);

		// A minified OutlineNode
		outlineTree = {
			element: {
				root: root,
				childrenContainer: root,
			},
			open: true,
			children: [],
		};

		outline.children.sort((symbolA, symbolB) =>{
			return symbolA.range.start.line - symbolB.range.end.line;
		});

		for (const child of outline.children){
			let node = buildOutline(child, outlineTree, depth + 1);

			outlineTree.children.push(node);
			node.element.root.classList.add('outline-root');
			root.appendChild(node.element.root);
		}
		setTimeout(()=>{
			// async to make sure the DOM is rendered first.
			let labelHeight = outlineTree.children[0].element.label.getBoundingClientRect().height;

			outlineHTML.setAttribute('style', (outlineHTML.getAttribute('style') ?? '') + `--label-height: ${labelHeight}px;`);
		}, 100);
		return outlineTree;
	}
	let outlineNode = new OutlineNode(outline);

	indexes.set(outlineNode.range, outlineNode);

	// set the reverse pointer point to parent for retrospective
	outlineNode.parent = parent;
	outlineNode.depth = depth;
	if (outline.children.length > 0){
		// Is not a leaf node
		outlineNode.children = outline.children;
	}
	return outlineNode;
}

class OutlineNode{

	element = new OutlineElement();
	/** @type {string} */		_name = undefined;
	/** @type {string} */		_type = undefined;
	/** @type {boolean} */		_open = undefined;
	/** @type {boolean} */		_visibility = undefined;
	/** @type {boolean} */		_highlight = undefined;
	/** @type {boolean} */		_focus = undefined;
	/** @type {Diagnostic[]} */	_diagnostics = [];
	/** @type {OutlineNode[]} */	_children = [];
	/** @type {OutlineNode} */	parent = [];
	/** @type {Range} */		_range;
	/** @type {number} */		_depth = 0;
	/** @type {string} */		_details = undefined;
	/**
	 * 
	 * @param {SymbolNode} outline 
	 */
	constructor(outline){
		this.name = outline.name;
		this.type = outline.type.toLowerCase();
		this.highlight = false;
		this.focus = false;
		this.open = outline.open;
		this.visibility = outline.display;
		this.range = outline.range;
		this.details = outline.details;
		this.element.name.addEventListener('click', () => {
			vscode.postMessage({
				type: 'goto',
				range: this.range,
			});
		});
		switch (config.expandOutlineMethod){
		case 'click':
			this.element.icon.addEventListener('click', (event)=>{
				if(this.children.length < 1){
					return;
				}
				this._open = !this._open;
				this.element.root.setAttribute('open', this._open.toString());
				if(this.element.childrenContainer && !this.element.childrenContainer.hasAttribute('hide-self')){
					this.parent.element.childrenContainer.removeAttribute('hide-self');
				}
			});
			break;
		case 'hover':
			// eslint-disable-next-line no-case-declarations
			let tempOpen = false;

			this.element.label.addEventListener('mouseover', (event)=>{
				if(this.open || this.children.length < 1){
					return;
				}
				event.stopPropagation();
				this._open = true;
				tempOpen = true;
				this.element.root.setAttribute('open', 'true');
				if(this.element.childrenContainer && !this.element.childrenContainer.hasAttribute('hide-self')){
					this.parent.element.childrenContainer.removeAttribute('hide-self');
				}
			});
			this.element.root.addEventListener('mouseleave', (event)=>{
				if(!tempOpen || this.children.length < 1){
					return;
				}
				event.stopPropagation();
				setTimeout(()=>{
					this._open = false;
					tempOpen = false;
					this.element.root.setAttribute('open', 'false');
				}, 300);
			});
			break;
		}
		this.element.icon.addEventListener('mouseenter', () => {
			if(this.children.length < 1){
				return;
			}
			this.element.icon.classList.add('hover');
			this.element.icon.style.cursor = 'pointer';
		});
		this.element.icon.addEventListener('mouseleave', () => {
			if(this.children.length < 1){
				return;
			}
			this.element.icon.classList.remove('hover');
			this.element.icon.style.cursor = 'default';
		});
	}
	get name(){
		return this._name;
	}
	set name(name){
		this._name = name;
		this.element.name.innerText = name;
		this.element.root.title = `${name} [${this.type}]`;
	}
	get details(){
		return this._name;
	}
	set details(details){
		this._details = details;
		this.element.details.innerText = details;
		this.element.details.title = details;
	}
	get type(){
		return this._type;
	}
	set type(type){
		type = type.toLocaleLowerCase();
		let color = style[type];

		this._type = type;
		this.element.root.setAttribute('type', type);
		this.element.root.setAttribute('style', `--color: ${color}`);
		this.element.icon.className = `codicon codicon-symbol-${type}`;
		this.element.root.title = `${this.name} [${type}]`;
	}
	get open(){
		return this._open;
	}
	set open(open){
		this._open = (open && this.children.length > 0 && this.depth < config.depth)
					|| (open && config.follow === 'cursor-always-open');

		this.element.root.setAttribute('open', this._open.toString());
	}
	get range(){
		return this._range;
	}
	set range(range){
		this._range = range;
	}
	get visibility(){
		return this._visibility;
	}
	set visibility(visibility){
		this._visibility = visibility;
		this.element.root.setAttribute('visibility', visibility.toString());
	}
	get highlight(){
		return this._highlight;
	}
	set highlight(highlight){
		this._highlight = highlight;
		this.element.root.setAttribute('highlight', highlight.toString());
	}
	get focus(){
		return this._focus;
	}
	set focus(focus){
		this._focus = focus;
		this.element.root.setAttribute('focus', focus.toString());
	}
	get diagnostics(){
		return this._diagnostics;
	}
	set diagnostics(diagnostics){
		this._diagnostics = [];
		this.element.label.removeAttribute('diagnostic-Hint');
		this.element.label.removeAttribute('diagnostic-Information');
		this.element.label.removeAttribute('diagnostic-Warning');
		this.element.label.removeAttribute('diagnostic-Error');
		this.pushDiagnostics(...diagnostics);
	}
	get children(){
		return this._children;
	}
	set children(children){
		this._children.forEach(child => {
			indexes?.delete(child.range);
		});
		let childrenContainer = document.createElement('div');

		childrenContainer.className = 'outline-children';
		this.element.childrenContainer && this.element.root.removeChild(this.element.childrenContainer);
		this.element.root.appendChild(childrenContainer);
		this.element.childrenContainer = childrenContainer;

		this._children = [];
		this.appendChildren(...children);
	}
	get depth(){
		return this._depth;
	}
	set depth(depth){
		this._depth = depth;
		// console.log(depth, config.depth);
		this.open = depth < config.depth;
	}
	/**
	 * 
	 * @param  {...SymbolNode} children 
	 */
	appendChildren(...children){
		children.sort((symbolA, symbolB) => {
			return symbolA.range.start.line - symbolB.range.start.line;
		});
		for (const child of children){
			let childNode = buildOutline(child, this, this.depth + 1);

			this._children.push(childNode);
			this.element.childrenContainer.appendChild(childNode.element.root);
		}
	}

	/**
	 * 
	 * @param  {...Diagnostic} diagnostics 
	 */
	pushDiagnostics(...diagnostics){
		for (const diagnostic of diagnostics){
			this._diagnostics.push(diagnostic);

			let count = +this.element.label.getAttribute(`diagnostic-${diagnostic.level}`) || 0;

			this.element.label.setAttribute(`diagnostic-${diagnostic.level}`, count + 1);
		}
	}

}

class OutlineElement{

	root;
	label;
	icon;
	name;
	details;
	/** @type {HTMLDivElement | undefined} */
	childrenContainer;
	constructor(){
		let root = document.createElement('div');

		root.classList.add('outline-node');
		let label = document.createElement('div');

		label.classList.add('outline-label');
		let icon = document.createElement('span');
		let name = document.createElement('span');
		let details = document.createElement('span');

		name.className = 'symbol-name';
		details.className = 'symbol-details';
		label.appendChild(icon);
		label.appendChild(name);
		label.appendChild(details);
		root.appendChild(label);
		this.root = root;
		this.label = label;
		this.icon = icon;
		this.name = name;
		this.details = details;
	}

}

class Toast{

	constructor(message, duration = 3000){
		this.message = message;
		this.duration = duration;
		this.element = document.createElement('div');
		this.element.classList.add('toast');
		this.element.innerText = message;
		document.body.appendChild(this.element);
		setTimeout(() => {
			this.remove();
		}, duration);
	}

	remove(){
		this.element.style.opacity = '0';
		setTimeout(() => {
			this.element.remove();
		}, 300);
	}

}

let style = {
	visibleRange: 'var(--vscode-scrollbarSlider-background)',
	focusingItem: 'var(--vscode-editorCursor-foreground)',
	module: 'var(--vscode-symbolIcon-moduleForeground)',
	namespace: 'var(--vscode-symbolIcon-namespaceForeground)',
	package: 'var(--vscode-symbolIcon-packageForeground)',
	class: 'var(--vscode-symbolIcon-classForeground)',
	method: 'var(--vscode-symbolIcon-methodForeground)',
	property: 'var(--vscode-symbolIcon-propertyForeground)',
	field: 'var(--vscode-symbolIcon-fieldForeground)',
	constructor: 'var(--vscode-symbolIcon-constructorForeground)',
	enum: 'var(--vscode-symbolIcon-enumeratorForeground)',
	interface: 'var(--vscode-symbolIcon-interfaceForeground)',
	function: 'var(--vscode-symbolIcon-functionForeground)',
	variable: 'var(--vscode-symbolIcon-variableForeground)',
	constant: 'var(--vscode-symbolIcon-constantForeground)',
	string: 'var(--vscode-symbolIcon-stringForeground)',
	number: 'var(--vscode-symbolIcon-numberForeground)',
	boolean: 'var(--vscode-symbolIcon-booleanForeground)',
	array: 'var(--vscode-symbolIcon-arrayForeground)',
	object: 'var(--vscode-symbolIcon-objectForeground)',
	key: 'var(--vscode-symbolIcon-keyForeground)',
	null: 'var(--vscode-symbolIcon-nullForeground)',
	enummember: 'var(--vscode-symbolIcon-enumeratorMemberForeground)',
	struct: 'var(--vscode-symbolIcon-structForeground)',
	event: 'var(--vscode-symbolIcon-eventForeground)',
	operator: 'var(--vscode-symbolIcon-operatorForeground)',
	typeparameter: 'var(--vscode-symbolIcon-typeParameterForeground)',
};

