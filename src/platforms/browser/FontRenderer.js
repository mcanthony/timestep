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
 * @package env.browser.FontRenderer;
 *
 * Render fonts or custom fonts on a Canvas context.
 */

import device;
import ui.resource.Font as Font;
import ui.Engine as Engine;
import .FontBuffer as FontBuffer;

var max = Math.max;

var _customFonts = {};
var _customFontInfo = {};
var _fontMap = {};
var _buffers = [];
var _fontBuffer = false;
var _origMeasureText;

exports.init = function () {
	var manifest = window.CONFIG;
	if (manifest && manifest.fonts) {
		var fonts = manifest.fonts;
		for (var i = 0, len = fonts.length; i < len; i++) {
			var font = fonts[i];
			var customFont = {
				filename: font.filename,
				settings: font,
				imagesLoaded: -1,
				imagesTotal: 0,
				loaded: false
			}
			_customFonts[font.filename] = customFont;
			loadingCustomFont(customFont);
		}
	}
};

var loadCustomFontImage = function(customFont, index) {
	var img = new GCImage({
		url: 'resources/fonts/' + customFont.filename + '_' + index + '.png'
	});
	img.doOnLoad(function () {
		customFont.imagesLoaded++;
		customFont.loaded = (customFont.imagesLoaded === customFont.imagesTotal);
	});
	return img;
};

var findVerticalInfo = function(dimensions) {
	// A..Z, a..z, all
	var ranges = [{start: 0x41, end: 0x5A}, {start: 0x61, end: 0x7A}, {start: 0x20, end: 0xFF}];
	var found = false;
	var baseline = 0;
	var bottom = 0;
	for (var i = 0, len = ranges.length; i < len; i++) {
		var range = ranges[i];
		for (var j = range.start; j <= range.end; j++) {
			var dimension = dimensions[j];
			if (dimension) {
				baseline = max(baseline, dimension.h);
				bottom = max(bottom, dimension.h);
				found = true;
			}
		}
		if (found) {
			break;
		}
	}
	return { baseline: baseline, bottom: bottom };
};

var findHorizontalInfo = function(dimensions) {
	// a..z, A..Z
	var ranges = [{start: 0x61, end: 0x7A}, {start: 0x41, end: 0x5A}, {start: 0x20, end: 0xFF}];
	var width = 0;
	var count = 0;
	for (var i = 0, len = ranges.length; i < len; i++) {
		var range = ranges[i];
		for (var j = range.start; j <= range.end; j++) {
			var dimension = dimensions[j];
			if (dimension) {
				width += dimension.w;
				count++;
			}
		}
		if (count !== 0) {
			break;
		}
	}
	return { width: 0.8 * width / count };
};

var loadingCustomFont = function(customFont) {
	if (customFont.imagesLoaded !== -1) {
	 	return !customFont.loaded;
	}

	var settings = customFont.settings;
	var filename = settings.filename;
	var info = _customFontInfo[filename];
	if (info) {
		customFont.dimensions = info.dimensions;
		customFont.horizontal = info.horizontal;
		customFont.vertical = info.vertical;
	} else {
		var json = CACHE['resources/fonts/' + filename + '.json'];
		customFont.dimensions = JSON.parse(json);
		customFont.horizontal = findHorizontalInfo(customFont.dimensions);
		customFont.vertical = findVerticalInfo(customFont.dimensions);

		_customFontInfo[filename] = {
			dimensions: customFont.dimensions,
			horizontal: customFont.horizontal,
			vertical: customFont.vertical
		};
	}

	var images = customFont.images = [];
	customFont.imagesLoaded = 0;
	for (var i = 0; i < settings.count; i++) {
		images.push(loadCustomFontImage(customFont, i));
		customFont.imagesTotal++;
	}
	return true;
};

var measure = function(ctx, fontInfo, text) {
	var customFont = fontInfo.customFont;
	var dimensions = customFont.dimensions;
	var scale = fontInfo.scale;
	var spacing = (customFont.settings.spacing || 0) * scale;
	var width = 0;
	var failed = true;

	if (dimensions) {
		failed = false;
		var prevCharCode = 0;
		for (var i = 0, len = text.length; i < len; i++) {
			var charCode = text.charCodeAt(i);
			if (charCode === 9) { // tab ...
				width += customFont.horizontal.width * 4 * scale;
			} else if (charCode === 32) { // space ...
				width += customFont.horizontal.width * scale;
			} else {
				if (dimensions[charCode]) {
					var character = dimensions[charCode];
					var kern = character.kerning[prevCharCode] || 0;
					width += (character.ow + kern) * scale + spacing;
				} else {
					failed = true;
				}
			}
			if (failed) {
				break;
			}
			prevCharCode = charCode;
		}
	}

	if (failed) {
		var font = ctx.font;
		ctx.font = fontInfo.size.value + fontInfo.size.unit + ' ' + (ctx.defaultFontFamily || device.defaultFontFamily);
		var result = { failed: true, width: _origMeasureText.apply(ctx, [text]) };
		ctx.font = font;
		return result;
	} else {
		return { failed: false, width: width };
	}
};

var renderCustomFont = function(ctx, x, y, text, color, fontInfo, index) {
	var measureInfo = measure(ctx, fontInfo, text);
	if (measureInfo.failed) {
		return false;
	}

	var customFont = fontInfo.customFont;
	var srcBuffers = customFont.images;
	var dimensions = customFont.dimensions;
	var scale = fontInfo.scale;
	var width = measureInfo.width;
	var spacing = (customFont.settings.spacing || 0) * scale;

	// nothing is ever vertically centered ...
	y -= 3;

	if (ctx.textBaseline === 'alphabetic') {
		y -= customFont.vertical.baseline * scale;
	} else if (ctx.textBaseline === 'middle') {
		y -= (customFont.vertical.bottom / 2) * scale;
	} else if (ctx.textBaseline === 'bottom') {
		y -= customFont.vertical.bottom * scale;
	}

	if (ctx.textAlign === 'center') {
		x -= width / 2;
	} else if (ctx.textAlign === 'right') {
		x -= width;
	}

	var buffer = false;
	var bufferX = x;
	var bufferY = y;
	if (buffer) {
		x = buffer.x;
		y = buffer.y;
		ctx = buffer.ctx;
	}

	if (!buffer || buffer.refresh) {
		var prevCharCode = 0;
		for (var i = 0, len = text.length; i < len; i++) {
			var charCode = text.charCodeAt(i);
			if (charCode === 9) { // tab ...
				x += customFont.horizontal.width * 4 * scale;
			} else if (charCode === 32) { // space ...
				x += customFont.horizontal.width * scale;
			} else {
				var character = dimensions[charCode];
				var kern = character.kerning[prevCharCode] || 0;
				x += kern;
				var img = srcBuffers[character.sheetIndex];
				img.render(
					ctx,
					character.x,
					character.y,
					character.w,
					character.h,
					x + character.ox * scale,
					y + character.oy * scale,
					character.w * scale,
					character.h * scale
				);
				x += character.ow * scale + spacing;
			}
			prevCharCode = charCode;
		}
	}

	if (buffer) {
		this.drawImage(
			buffer.ctx.canvas,
			buffer.x,
			buffer.y,
			buffer.width,
			buffer.height,
			bufferX,
			bufferY,
			buffer.width,
			buffer.height
		);
	}

	return true;
};

exports.findFontInfo = function (ctx) {
	var font = Font.parse(ctx.font);
	var name = font.getName();
	if (name && _customFonts[name]) {
		customFont = _customFonts[name];
		font.customFont = customFont;
		font.scale = font.getSize() / customFont.settings.size;
		return font;
	}
	return null;
};

exports.wrapMeasureText = function (origMeasureText) {
	_origMeasureText = origMeasureText;
	return function (text) {
		var fontInfo = exports.findFontInfo(this);
		if (!fontInfo) {
			return origMeasureText.apply(this, arguments);
		}
		var measureInfo = measure(this, fontInfo, text);
		if (measureInfo.failed) {
			return origMeasureText.apply(this, arguments);
		}
		return measureInfo;
	}
};

exports.wrapFillText = function (origFillText) {
	return function (text, x, y) {
		var fontInfo = exports.findFontInfo(this);
		if (!fontInfo) {
			return origFillText.apply(this, arguments);
		}
		if (loadingCustomFont(fontInfo.customFont)) {
			return;
		}
		if (isNaN(x)) {
			x = 0;
		}
		if (isNaN(y)) {
			y = 0;
		}

		if (!renderCustomFont(this, x, y, text + '', this.fillStyle, fontInfo, 0)) {
			var font = this.font;
			this.font = fontInfo.size.value + fontInfo.size.unit + ' ' + (this.defaultFontFamily || device.defaultFontFamily);
			origFillText.apply(this, [text, x, y]);
			this.font = font;
		}
	}
};

exports.wrapStrokeText = function (origStrokeText) {
	return function (text, x, y) {
		var fontInfo = exports.findFontInfo(this);
		if (!fontInfo) {
			return origStrokeText.apply(this, arguments);
		}
		if (loadingCustomFont(fontInfo.customFont)) {
			return;
		}
		if (isNaN(x)) {
			x = 0;
		}
		if (isNaN(y)) {
			y = 0;
		}

		if (!renderCustomFont(this, x, y, text + '', this.strokeStyle, fontInfo, 1)) {
			var font = this.font;
			this.font = fontInfo.size.value + fontInfo.size.unit + ' ' + (this.defaultFontFamily || device.defaultFontFamily);
			origStrokeText.apply(this, [text, x, y]);
			this.font = font;
		}
	}
};

exports.getFontBuffer = function () {
	return _fontBuffer;
};
