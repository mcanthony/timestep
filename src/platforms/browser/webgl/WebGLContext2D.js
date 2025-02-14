/**
 * @license
 * This file is part of the Game Closure SDK.
 *
 * The Game Closure SDK is free software: you can redistribute it and/or modify
 * it under the terms of the Mozilla Public License v. 2.0 as published by Mozilla.

 * The Game Closure SDK is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * Mozilla Public License v. 2.0 for more details.

 * You should have received a copy of the Mozilla Public License v. 2.0
 * along with the Game Closure SDK.  If not, see <http://mozilla.org/MPL/2.0/>.
 */

/**
 * @package timestep.env.browser.WebGLContext2D;
 *
 * Generates a WebGL rendering context by creating our own Canvas element.
 */

import device;

import ui.resource.loader as loader;
import ui.Color as Color;

import .TextManager;
import .Shaders;
import .Matrix2D;

var ContextStateStack = Class(function() {

	this.init = function() {
		this._states = [this.getObject()];
		this._stateIndex = 0;
	};

	this.save = function() {
		var lastState = this.state;
		if (++this._stateIndex >= this._states.length) {
			this._states[this._stateIndex] = this.getObject();
		}
		var s = this.state;
		s.globalCompositeOperation = lastState.globalCompositeOperation;
		s.globalAlpha = lastState.globalAlpha;
		s.transform.copy(lastState.transform);
		s.textBaseLine = lastState.textBaseLine;
		s.lineWidth = lastState.lineWidth;
		s.strokeStyle = lastState.strokeStyle;
		s.fillStyle = lastState.fillStyle;
		s.filter = lastState.filter;
		s.clip = lastState.clip;
		s.clipRect.x = lastState.clipRect.x;
		s.clipRect.y = lastState.clipRect.y;
		s.clipRect.width = lastState.clipRect.width;
		s.clipRect.height = lastState.clipRect.height;
	};

	this.restore = function() {
		if (this._stateIndex > 0) {
			this._stateIndex--;
		}
	};

	this.getObject = function() {
		return {
			globalCompositeOperation: "source-over",
			globalAlpha: 1,
			transform: new Matrix2D(),
			filter: null,
			clip: false,
			clipRect: { x: 0, y: 0, width: 0, height: 0 },
			fillStyle: ""
		};
	};

	Object.defineProperty(this, 'state', {
		get: function() { return this._states[this._stateIndex]; }
	});
});

var STRIDE = 24;

var RENDER_MODES = {
	Default: 0,
	LinearAdd: 1,
	Tint: 2,
	Multiply: 3,
	Rect: 4,
	PositiveMask: 0,
	NegativeMask: 0
};

var COLOR_MAP = {};

var getColor = function(key) {
	var result = COLOR_MAP[key];
	if (!result) {
		result = COLOR_MAP[key] = Color.parse(key);
	}
	return result;
};

var GLManager = Class(function() {

	var MAX_BATCH_SIZE = 1024;

	this.init = function () {
		var webglSupported = false;

		try {
			var testCanvas = document.createElement('canvas');
			webglSupported = !!(window.WebGLRenderingContext && testCanvas.getContext('webgl'));
		} catch(e) {}

		this.width = device.width;
		this.height = device.height;
		this.isSupported = webglSupported;

		if (!this.isSupported) { return; }

		this.textManager = new TextManager();

		this._helperTransform = new Matrix2D();

		this._canvas = document.createElement('canvas');
		this._canvas.width = this.width;
		this._canvas.height = this.height;
		this._canvas.getWebGLContext = this._canvas.getContext.bind(this._canvas, 'webgl', { alpha: true, premultipliedAlpha: true });

		this._indexCache = new Uint16Array(MAX_BATCH_SIZE * 6);
		this._vertexCache = new ArrayBuffer(MAX_BATCH_SIZE * STRIDE * 4);
		this._vertices = new Float32Array(this._vertexCache);
		this._colors = new Uint8Array(this._vertexCache);

		var indexCount = MAX_BATCH_SIZE * 6;
		for (var i = 0, j = 0; i < indexCount; i += 6, j += 4) {
			this._indexCache[i] = j;
			this._indexCache[i + 1] = j + 2;
			this._indexCache[i + 2] = j + 3;
			this._indexCache[i + 3] = j;
			this._indexCache[i + 4] = j + 3;
			this._indexCache[i + 5] = j + 1;
		}

		this._batchQueue = new Array(MAX_BATCH_SIZE);

		for (var i = 0; i <= MAX_BATCH_SIZE; i++) {
			this._batchQueue[i] = {
				textureId: 0,
				index: 0,
				clip: false,
				filter: null,
				clipRect: { x: 0, y: 0, width: 0, height: 0 },
				renderMode: 0
			};
		}

		this.contexts = [];
		this.initGL();
		this._primaryContext = new Context2D(this, this._canvas);
		this.activate(this._primaryContext);

		loader.on(loader.IMAGE_LOADED, function(image) {
			var glId = image.__GL_ID;
			if (glId === undefined) {
				glId = this.createTexture(image);
			}
		}.bind(this));

		this.contextActive = true;

		device.screen.on('Resize', this.updateCanvasDimensions.bind(this));
		this._canvas.addEventListener('webglcontextlost', this.handleContextLost.bind(this), false);
		this._canvas.addEventListener('webglcontextrestored', this.handleContextRestored.bind(this), false);
	};

	this.handleContextLost = function(e) {
		e.preventDefault();
		this.contextActive = false;
		this.gl = null;
	};

	this.handleContextRestored = function() {
		this.initGL();
		this.contextActive = true;
	};

	this.initGL = function () {
		var gl = this.gl = this._canvas.getWebGLContext();

		gl.clearColor(0.0, 0.0, 0.0, 0.0);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.BLEND);
		gl.blendEquation(gl.FUNC_ADD);
		gl.activeTexture(gl.TEXTURE0);

		this._scissorEnabled = false;
		this._activeScissor = { x: 0, y: 0, width: 0, height: 0 };

		this.setActiveCompositeOperation('source-over');
		this._activeRenderMode = -1;

		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

		this.textureCache = [];
		this._drawIndex = -1;
		this._batchIndex = -1;

		// Initialize Buffers
		this._indexBuffer = gl.createBuffer();
		this._vertexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this._indexCache, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, this._vertexCache, gl.DYNAMIC_DRAW);

		// Initialize Shaders
		this.shaders = [];
		this.shaders[RENDER_MODES.Default] = new Shaders.DefaultShader({ gl: gl });
		this.shaders[RENDER_MODES.LinearAdd] = new Shaders.LinearAddShader({ gl: gl });
		this.shaders[RENDER_MODES.Tint] = new Shaders.TintShader({ gl: gl });
		this.shaders[RENDER_MODES.Multiply] = new Shaders.MultiplyShader({ gl: gl });
		this.shaders[RENDER_MODES.Rect] = new Shaders.RectShader({ gl: gl });

		this.reloadTextures();
		this.updateContexts();
	};

	this.reloadTextures = function() {
		var oldCanvases = this.canvasCache;
		this.canvasCache = [];
		if (oldCanvases) {
			for (var i = 0; i < oldCanvases.length; i++) {
				this.createTexture(oldCanvases[i]);
			}
		}
	};

	this.updateContexts = function() {
		for (var i = 0; i < this.contexts.length; i++) {
			this.contexts[i].createOffscreenFrameBuffer();
		}
	};

	this.updateCanvasDimensions = function() {
		this._primaryContext.resize(device.screen.width, device.screen.height);
	};

	this.getContext = function(canvas, opts) {
		opts = opts || {};

		var ctx;
		if (opts.offscreen === false) {
			ctx = this._primaryContext;
			ctx.resize(opts.width, opts.height);
		} else {
			ctx = new Context2D(this, canvas);
			ctx.createOffscreenFrameBuffer();
			this.contexts.push(ctx);
		}

		return ctx;
	};

	this.setActiveRenderMode = function(id) {
		if (this._activeRenderMode === id || !this.gl) { return; }
		var ctx = this._activeCtx;
		this._activeRenderMode = id;
		var shader = this.shaders[id];
		gl.useProgram(shader.program);
		gl.uniform2f(shader.uniforms.uResolution, ctx.width, ctx.height);
		if (shader.uniforms.uSampler !== -1) {
			gl.uniform1i(shader.uniforms.uSampler, 0);
		}
	};

	this.setActiveCompositeOperation = function(op) {

		op = op || 'source-over';
		if (this._activeCompositeOperation === op || !this.gl) { return; }
		this._activeCompositeOperation = op;

		var gl = this.gl;
		var source;
		var destination;

		switch(op) {
			case 'source-over':
				source = gl.ONE;
				destination = gl.ONE_MINUS_SRC_ALPHA;
				break;

			case 'source-atop':
				source = gl.DST_ALPHA;
				destination = gl.ONE_MINUS_SRC_ALPHA;
				break;

			case 'source-in':
				source = gl.DST_ALPHA;
				destination = gl.ZERO;
				break;

			case 'source-out':
				source = gl.ONE_MINUS_DST_ALPHA;
				destination = gl.ZERO;
				break;

			case 'destination-atop':
				source = gl.DST_ALPHA;
				destination = gl.SRC_ALPHA;
				break;

			case 'destination-in':
				source = gl.ZERO;
				destination = gl.SRC_ALPHA;
				break;

			case 'destination-out':
				source = gl.ONE_MINUS_SRC_ALPHA;
				destination = gl.ONE_MINUS_SRC_ALPHA;
				break;

			case 'destination-over':
				source = gl.DST_ALPHA;
				destination = gl.SRC_ALPHA;
				break;

			case 'lighter':
				source = gl.ONE;
				destination = gl.ONE;
				break;

			case 'xor':
			case 'copy':
				source = gl.ONE;
				destination = gl.ONE_MINUS_SRC_ALPHA;
				break;

			default:
				source = gl.ONE;
				destination = gl.ONE_MINUS_SRC_ALPHA;
				break;
		}
		gl.blendFunc(source, destination);
	};

	this.flush = function() {
		if (this._batchIndex === -1 || !this.gl) { return; }

		var gl = this.gl;
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._vertexCache);
		this._batchQueue[this._batchIndex + 1].index = this._drawIndex + 1;

		for (var i = 0; i <= this._batchIndex; i++) {
			var curQueueObj = this._batchQueue[i];
			if (curQueueObj.clip) {
				var r = curQueueObj.clipRect;
				this.enableScissor(r.x, r.y, r.width, r.height);
			} else {
				this.disableScissor();
			}
			var textureId = curQueueObj.textureId;
			if (textureId !== -1) {
				gl.bindTexture(gl.TEXTURE_2D, this.textureCache[curQueueObj.textureId]);
			}
			this.setActiveCompositeOperation(curQueueObj.globalCompositeOperation);
			this.setActiveRenderMode(curQueueObj.renderMode);
			var start = curQueueObj.index;
			var next = this._batchQueue[i + 1].index;
			gl.drawElements(gl.TRIANGLES, (next - start) * 6, gl.UNSIGNED_SHORT, start * 12);
		}

		this._drawIndex = -1;
		this._batchIndex = -1;
	};

	this.createTexture = function(image, id) {
		var gl = this.gl;
		if (!gl) { return -1; }

		if (!id) { id = this.textureCache.length; }
		var texture = this.textureCache[id] || gl.createTexture();

		gl.bindTexture(gl.TEXTURE_2D, texture);

		if (image instanceof HTMLCanvasElement || image instanceof Image) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
		} else {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		}

		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.textureCache[id] = texture;
		this.canvasCache[id] = image;
		image.__GL_ID = id;
		return id;
	};

	this.getTexture = function(id) {
		return this.textureCache[id];
	};

	this.deleteTexture = function(id) {
		var texture = this.textureCache[id];
		this._gl.deleteTexture(texture);
		delete this.textureCache[id];
	};

	this.enableScissor = function(x, y, width, height) {
		if (!this.gl) { return; }
		var gl = this.gl;
		if (!this._scissorEnabled) {
			gl.enable(gl.SCISSOR_TEST);
			this._scissorEnabled = true;
		}
		var s = this._activeScissor;
		if (x !== s.x || y !== s.y || width !== s.width || height !== s.height) {
			s.x = x;
			s.y = y;
			s.width = width;
			s.height = height;
			gl.scissor(x, this.height - height - y, width, height);
		}
	};

	this.disableScissor = function() {
		if (!this.gl) { return; }
		if (this._scissorEnabled) {
			var gl = this.gl;
			this._scissorEnabled = false;
			gl.disable(gl.SCISSOR_TEST);
		}
	};

	this.addToBatch = function(state, textureId) {
		if (this._drawIndex >= MAX_BATCH_SIZE - 1) { this.flush(); }
		this._drawIndex++;

		var filter = state.filter;
		var clip = state.clip;
		var clipRect = state.clipRect;

		var queuedState = this._batchIndex > -1 ? this._batchQueue[this._batchIndex] : null;
		var stateChanged = !queuedState
				|| queuedState.textureId !== textureId
				|| (textureId === -1 && queuedState.fillStyle !== state.fillStyle)
				|| queuedState.globalCompositeOperation !== state.globalCompositeOperation
				|| queuedState.filter !== filter
				|| queuedState.clip !== clip
				|| queuedState.clipRect.x !== clipRect.x
				|| queuedState.clipRect.y !== clipRect.y
				|| queuedState.clipRect.width !== clipRect.width
				|| queuedState.clipRect.height !== clipRect.height;

		if (stateChanged) {
			var queueObject = this._batchQueue[++this._batchIndex];
			queueObject.textureId = textureId;
			queueObject.index = this._drawIndex;
			queueObject.globalCompositeOperation = state.globalCompositeOperation;
			queueObject.filter = filter;
			queueObject.clip = clip;
			queueObject.clipRect.x = clipRect.x;
			queueObject.clipRect.y = clipRect.y;
			queueObject.clipRect.width = clipRect.width;
			queueObject.clipRect.height = clipRect.height;
			if (textureId === -1) {
				queueObject.renderMode = RENDER_MODES.Rect;
			} else if (filter) {
				queueObject.renderMode = RENDER_MODES[filter.getType()];
			} else {
				queueObject.renderMode = RENDER_MODES.Default;
			}
		}

		return this._drawIndex;
	};

	this.isPowerOfTwo = function (width, height) {
		return width > 0 && (width & (width - 1)) === 0 && height > 0 && (height & (height - 1)) === 0;
	};

	this.activate = function (ctx, forceActivate) {
		var gl = this.gl;
		if ((!forceActivate && ctx === this._activeCtx) || !gl) { return; }
		this.flush();
		gl.finish();
		gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.frameBuffer);
		gl.viewport(0, 0, ctx.width, ctx.height);
		this._activeCtx = ctx;
		this._activeRenderMode = -1;
	}
});

// Create a context to measure text
var textCtx = document.createElement("canvas").getContext("2d");

// ---------------------------------------------------------------------------
// CONTEXT2D
// ---------------------------------------------------------------------------

var Context2D = Class(function () {

	var createContextProperty = function(ctx, name) {
		Object.defineProperty(ctx, name, {
			get: function() { return this.stack.state[name]; },
			set: function(value) { this.stack.state[name] = value; }
		});
	};

	var contextProperties = [
		'globalAlpha',
		'globalCompositeOperation',
		'textBaseLine',
		'lineWidth',
		'strokeStyle',
		'fillStyle',
		'font'
	];

	for (var i = 0; i < contextProperties.length; i++) {
		createContextProperty(this, contextProperties[i]);
	}

	this.init = function (manager, canvas) {
		this._manager = manager;
		this.canvas = canvas;
		this.width = canvas.width;
		this.height = canvas.height;
		this.stack = new ContextStateStack();
		this.font = '11px ' + device.defaultFontFamily;
		this.frameBuffer = null;
		this.filters = {};
		this.flip = false;
	};

	this.createOffscreenFrameBuffer = function () {
		var gl = this._manager.gl;
		if (!gl) { return; }
		var id = this._manager.createTexture(this.canvas);
		this._texture = this._manager.getTexture(id);
	  this.frameBuffer = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.frameBuffer);
		gl.bindTexture(gl.TEXTURE_2D, this._texture);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texture, 0);
		this.clear();
		gl.bindTexture(gl.TEXTURE_2D, null);
		gl.bindRenderbuffer(gl.RENDERBUFFER, null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.flip = true;
	};

	var min = Math.min;
	var max = Math.max;

	this.loadIdentity = function() {
		this.stack.state.transform.identity();
	};

	this.setTransform = function(a, b, c, d, tx, ty) {
		this.stack.state.transform.setTo(a, b, c, d, tx, ty);
	};

	this.transform = function(a, b, c, d, tx, ty) {
		this._helperTransform.setTo(a, b, c, d, tx, ty);
		this.stack.state.transform.transform(this._helperTransform);
	};

	this.scale = function(x, y) {
		this.stack.state.transform.scale(x, y);
	};

	this.translate = function(x, y) {
		this.stack.state.transform.translate(x, y);
	};

	this.rotate = function(angle) {
		this.stack.state.transform.rotate(angle);
	};

	this.getElement = function() { return this.canvas; };

	this.reset = function() {};

	this.clear = function() {
		this._manager.activate(this);
		this._manager.flush();
		var gl = this._manager.gl;
		if (gl) {
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
	};

	this.resize = function(width, height) {
		this.width = width;
		this.height = height;
		this._manager.activate(this, true);
		if (this._texture && this._manager.gl) {
			var gl = this._manager.gl;
			gl.bindTexture(gl.TEXTURE_2D, this._texture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		}
	};

	this.clipRect = function(x, y, width, height) {
		var m = this.stack.state.transform;
		var xW = x + width;
		var yH = y + height;
		var x0 = x * m.a + y * m.c + m.tx;
		var y0 = x * m.b + y * m.d + m.ty;
		var x1 = xW * m.a + y * m.c + m.tx;
		var y1 = xW * m.b + y * m.d + m.ty;
		var x2 = x * m.a + yH * m.c + m.tx;
		var y2 = x * m.b + yH * m.d + m.ty;
		var x3 = xW * m.a + yH * m.c + m.tx;
		var y3 = xW * m.b + yH * m.d + m.ty;

		var minX = min(this.width, x0, x1, x2, x3);
		var maxX = max(0, x0, x1, x2, x3);
		var minY = min(this.height, y0, y1, y2, y3);
		var maxY = max(0, y0, y1, y2, y3);

		this.stack.state.clip = true;
		var r = this.stack.state.clipRect;
		r.x = minX;
		r.y = minY;
		r.width = maxX - minX;
		r.height = maxY - minY;
	};

	this.swap = function() {
		this._manager.flush();
	};

	this.execSwap = function() {};

	this.setFilters = function(filters) {
		this.clearFilters();
		for (var filterId in filters) {
			this.stack.state.filter = filters[filterId];
			this.filters[filterId] = filters[filterId];
			return;
		}
		this.stack.state.filter = null;
	};

	this.clearFilters = function() {
		for (var name in this.filters) {
			delete this.filters[name];
		}
		this.stack.state.filter = null;
	};

	this.save = function() {
		this.stack.save();
	};

	this.restore = function() {
		this.stack.restore();
	};

	this.strokeRect = function() {};
	this.circle = function(x, y, radius) {};
	this.drawPointSprites = function(x1, y1, x2, y2) {};
	this.roundRect = function (x, y, width, height, radius) {};

	this.fillText = function(text, x, y) {
		if (!this._manager.gl) { return; }
		var textData = this._manager.textManager.get(this, text, false);
		if (!textData) { return; }
		var w = textData.image.width;
		var h = textData.image.height;
		this.drawImage(textData.image, 0, 0, w, h, x, y, w, h);
	};

	this.strokeText = function(text, x, y) {
		if (!this._manager.gl) { return; }
		var textData = this._manager.textManager.get(this, text, true);
		if (!textData) { return; }
		var w = textData.image.width;
		var h = textData.image.height;
		this.drawImage(textData.image, 0, 0, w, h, x - this.lineWidth * 0.5, y - this.lineWidth * 0.5, w, h);
	};

	this.measureText = function(text) {
		textCtx.font = this.font;
		return textCtx.measureText(text);
	};

	this.drawImage = function(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) {

		if (!this._manager.gl) { return; }

		var state = this.stack.state;
		var alpha = state.globalAlpha;
		if (alpha === 0) { return; }

		var manager = this._manager;
		manager.activate(this);

		var glId = image.__GL_ID;
		if (glId === undefined || image.__needsUpload) {
			// Invalid image? Early out if so.
			if (image.width === 0 || image.height === 0 || !image.complete) { return; }
			image.__needsUpload = false;
			glId = manager.createTexture(image, glId);
		}

		var drawIndex = manager.addToBatch(this.stack.state, glId);
		var width = this.width;
		var height = this.height;
		var imageWidth = image.width;
		var imageHeight = image.height;
		var m = state.transform;
		var sxW = sx + sWidth;
		var syH = sy + sHeight;
		var dxW = dx + dWidth;
		var dyH = dy + dHeight;

		var needsTrim = sx < 0 || sxW > imageWidth || sy < 0 || syH > imageHeight;

		if (needsTrim) {
			var newSX = max(0, sx);
			var newSY = max(0, sy);
			var newSXW = min(sxW, imageWidth);
			var newSYH = min(syH, imageHeight);
			var scaleX = dWidth / sWidth;
			var scaleY = dHeight / sHeight;
			var trimLeft = (newSX - sx) * scaleX;
			var trimRight = (sxW - newSXW) * scaleX;
			var trimTop = (newSY - sy) * scaleY;
			var trimBottom = (syH - newSYH) * scaleY;
			dx += trimLeft;
			dxW -= trimRight;
			dy += trimTop;
			dyH -= trimBottom;
			sx = newSX;
			sy = newSY;
			sxW = newSXW;
			syH = newSYH;
		}

		// Calculate 4 vertex positions
		var x0 = dx * m.a + dy * m.c + m.tx;
		var y0 = dx * m.b + dy * m.d + m.ty;
		var x1 = dxW * m.a + dy * m.c + m.tx;
		var y1 = dxW * m.b + dy * m.d + m.ty;
		var x2 = dx * m.a + dyH * m.c + m.tx;
		var y2 = dx * m.b + dyH * m.d + m.ty;
		var x3 = dxW * m.a + dyH * m.c + m.tx;
		var y3 = dxW * m.b + dyH * m.d + m.ty;

		// TOOD: remove private access to _vertices
		var tw = 1 / imageWidth;
		var th = 1 / imageHeight;
		var vc = manager._vertices;
		var i = drawIndex * 6 * 4;

		var uLeft = sx * tw;
		var uRight = sxW * tw;
		var vTop = this.flip ? syH * th : sy * th;
		var vBottom = this.flip ? sy * th : syH * th;

		vc[i + 0] = x0;
		vc[i + 1] = y0;
		vc[i + 2] = uLeft; // u0
		vc[i + 3] = vTop; // v0
		vc[i + 4] = alpha;

		vc[i + 6] = x1;
		vc[i + 7] = y1;
		vc[i + 8] = uRight; // u1
		vc[i + 9] = vTop; // v1
		vc[i + 10] = alpha;

		vc[i + 12] = x2;
		vc[i + 13] = y2;
		vc[i + 14] = uLeft; // u2
		vc[i + 15] = vBottom; // v2
		vc[i + 16] = alpha;

		vc[i + 18] = x3;
		vc[i + 19] = y3;
		vc[i + 20] = uRight; // u4
		vc[i + 21] = vBottom; // v4
		vc[i + 22] = alpha;

		if (state.filter) {
			var color = state.filter.get();
			var ci = drawIndex * 4 * STRIDE;
			var cc = manager._colors;
			cc[ci + 20] = cc[ci + 44] = cc[ci + 68] = cc[ci + 92] = color.r; // R
			cc[ci + 21] = cc[ci + 45] = cc[ci + 69] = cc[ci + 93] = color.g; // G
			cc[ci + 22] = cc[ci + 46] = cc[ci + 70] = cc[ci + 94] = color.b; // B
			cc[ci + 23] = cc[ci + 47] = cc[ci + 71] = cc[ci + 95] = color.a * 255; // A
		}
	};

	this.fillRect = function(x, y, width, height) {

		if (this.globalAlpha === 0) { return; }

		var m = this.stack.state.transform;
		var xW = x + width;
		var yH = y + height;

		// Calculate 4 vertex positions
		var x0 = x * m.a + y * m.c + m.tx;
		var y0 = x * m.b + y * m.d + m.ty;
		var x1 = xW * m.a + y * m.c + m.tx;
		var y1 = xW * m.b + y * m.d + m.ty;
		var x2 = x * m.a + yH * m.c + m.tx;
		var y2 = x * m.b + yH * m.d + m.ty;
		var x3 = xW * m.a + yH * m.c + m.tx;
		var y3 = xW * m.b + yH * m.d + m.ty;

		var manager = this._manager;
		manager.activate(this);
		var drawIndex = manager.addToBatch(this.stack.state, -1);

		// TODO: remove private access to _vertices
		var vc = manager._vertices;
		var i = drawIndex * 6 * 4;

		vc[i + 0] = x0;
		vc[i + 1] = y0;
		vc[i + 4] = this.globalAlpha;

		vc[i + 6] = x1;
		vc[i + 7] = y1;
		vc[i + 10] = this.globalAlpha;

		vc[i + 12] = x2;
		vc[i + 13] = y2;
		vc[i + 16] = this.globalAlpha;

		vc[i + 18] = x3;
		vc[i + 19] = y3;
		vc[i + 22] = this.globalAlpha;

		var fillColor = getColor(this.stack.state.fillStyle);
		var ci = drawIndex * 4 * STRIDE;
		var cc = manager._colors;
		cc[ci + 20] = cc[ci + 44] = cc[ci + 68] = cc[ci + 92] = fillColor.r; // R
		cc[ci + 21] = cc[ci + 45] = cc[ci + 69] = cc[ci + 93] = fillColor.g; // G
		cc[ci + 22] = cc[ci + 46] = cc[ci + 70] = cc[ci + 94] = fillColor.b; // B
		cc[ci + 23] = cc[ci + 47] = cc[ci + 71] = cc[ci + 95] = fillColor.a * 255; // A
	};

	this.deleteTextureForImage = function(canvas) {
		if (!this._manager.gl) { return; }
		this._manager.deleteTextureById(canvas.__GL_ID);
	};

});

exports = new GLManager();
