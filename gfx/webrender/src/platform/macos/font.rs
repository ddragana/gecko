/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use api::{ColorU, FontKey, FontRenderMode, GlyphDimensions};
use api::{FontInstanceFlags, FontVariation, NativeFontHandle};
use app_units::Au;
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::TCFType;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::{CFNumber, CFNumberRef};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::base::{kCGImageAlphaNoneSkipFirst, kCGBitmapByteOrder32Little};
#[cfg(not(feature = "pathfinder"))]
use core_graphics::base::kCGImageAlphaPremultipliedFirst;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::CGContext;
#[cfg(not(feature = "pathfinder"))]
use core_graphics::context::CGTextDrawingMode;
use core_graphics::data_provider::CGDataProvider;
use core_graphics::font::{CGFont, CGGlyph};
use core_graphics::geometry::{CGAffineTransform, CGPoint, CGSize};
#[cfg(not(feature = "pathfinder"))]
use core_graphics::geometry::CGRect;
use core_text;
use core_text::font::{CTFont, CTFontRef};
use core_text::font_descriptor::{kCTFontDefaultOrientation, kCTFontColorGlyphsTrait};
use gamma_lut::{ColorLut, GammaLut};
use glyph_rasterizer::{FontInstance, FontTransform, GlyphKey};
#[cfg(feature = "pathfinder")]
use glyph_rasterizer::NativeFontHandleWrapper;
#[cfg(not(feature = "pathfinder"))]
use glyph_rasterizer::{GlyphFormat, GlyphRasterResult, RasterizedGlyph};
use internal_types::{FastHashMap, ResourceCacheError};
use std::collections::hash_map::Entry;
use std::sync::Arc;

pub struct FontContext {
    cg_fonts: FastHashMap<FontKey, CGFont>,
    ct_fonts: FastHashMap<(FontKey, Au, Vec<FontVariation>), CTFont>,
    #[allow(dead_code)]
    gamma_lut: GammaLut,
}

// core text is safe to use on multiple threads and non-shareable resources are
// all hidden inside their font context.
unsafe impl Send for FontContext {}

struct GlyphMetrics {
    rasterized_left: i32,
    #[allow(dead_code)]
    rasterized_descent: i32,
    rasterized_ascent: i32,
    rasterized_width: u32,
    rasterized_height: u32,
    advance: f32,
}

// According to the Skia source code, there's no public API to
// determine if subpixel AA is supported. So jrmuizel ported
// this function from Skia which is used to check if a glyph
// can be rendered with subpixel AA.
fn supports_subpixel_aa() -> bool {
    let mut cg_context = CGContext::create_bitmap_context(
        None,
        1,
        1,
        8,
        4,
        &CGColorSpace::create_device_rgb(),
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little,
    );
    let ct_font = core_text::font::new_from_name("Helvetica", 16.).unwrap();
    cg_context.set_should_smooth_fonts(true);
    cg_context.set_should_antialias(true);
    cg_context.set_rgb_fill_color(1.0, 1.0, 1.0, 1.0);
    let point = CGPoint { x: -1., y: 0. };
    let glyph = '|' as CGGlyph;
    ct_font.draw_glyphs(&[glyph], &[point], cg_context.clone());
    let data = cg_context.data();
    data[0] != data[1] || data[1] != data[2]
}

fn should_use_white_on_black(color: ColorU) -> bool {
    let (r, g, b) = (color.r as u32, color.g as u32, color.b as u32);
    // These thresholds were determined on 10.12 by observing what CG does.
    r >= 85 && g >= 85 && b >= 85 && r + g + b >= 2 * 255
}

fn get_glyph_metrics(
    ct_font: &CTFont,
    transform: Option<&CGAffineTransform>,
    glyph: CGGlyph,
    x_offset: f64,
    y_offset: f64,
    extra_width: f64,
) -> GlyphMetrics {
    let mut bounds = ct_font.get_bounding_rects_for_glyphs(kCTFontDefaultOrientation, &[glyph]);

    if bounds.origin.x.is_nan() || bounds.origin.y.is_nan() || bounds.size.width.is_nan() ||
        bounds.size.height.is_nan()
    {
        // If an unexpected glyph index is requested, core text will return NaN values
        // which causes us to do bad thing as the value is cast into an integer and
        // overflow when expanding the bounds a few lines below.
        // Instead we are better off returning zero-sized metrics because this special
        // case is handled by the callers of this method.
        return GlyphMetrics {
            rasterized_left: 0,
            rasterized_width: 0,
            rasterized_height: 0,
            rasterized_ascent: 0,
            rasterized_descent: 0,
            advance: 0.0,
        };
    }

    let mut advance = CGSize { width: 0.0, height: 0.0 };
    ct_font.get_advances_for_glyphs(kCTFontDefaultOrientation, &glyph, &mut advance, 1);

    if bounds.size.width > 0.0 {
        bounds.size.width += extra_width;
    }
    if advance.width > 0.0 {
        advance.width += extra_width;
    }

    if let Some(transform) = transform {
        bounds = bounds.apply_transform(transform);
    }

    // First round out to pixel boundaries
    // CG Origin is bottom left
    let mut left = bounds.origin.x.floor() as i32;
    let mut bottom = bounds.origin.y.floor() as i32;
    let mut right = (bounds.origin.x + bounds.size.width + x_offset).ceil() as i32;
    let mut top = (bounds.origin.y + bounds.size.height + y_offset).ceil() as i32;

    // Expand the bounds by 1 pixel, to give CG room for anti-aliasing.
    // Note that this outset is to allow room for LCD smoothed glyphs. However, the correct outset
    // is not currently known, as CG dilates the outlines by some percentage.
    // This is taken from Skia.
    left -= 1;
    bottom -= 1;
    right += 1;
    top += 1;

    let width = right - left;
    let height = top - bottom;

    GlyphMetrics {
        rasterized_left: left,
        rasterized_width: width as u32,
        rasterized_height: height as u32,
        rasterized_ascent: top,
        rasterized_descent: -bottom,
        advance: advance.width as f32,
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern {
    static kCTFontVariationAxisIdentifierKey: CFStringRef;
    static kCTFontVariationAxisNameKey: CFStringRef;
    static kCTFontVariationAxisMinimumValueKey: CFStringRef;
    static kCTFontVariationAxisMaximumValueKey: CFStringRef;
    static kCTFontVariationAxisDefaultValueKey: CFStringRef;

    fn CTFontCopyVariationAxes(font: CTFontRef) -> CFArrayRef;
}

fn new_ct_font_with_variations(cg_font: &CGFont, size: f64, variations: &[FontVariation]) -> CTFont {
    unsafe {
        let ct_font = core_text::font::new_from_CGFont(cg_font, size);
        if variations.is_empty() {
            return ct_font;
        }
        let axes_ref = CTFontCopyVariationAxes(ct_font.as_concrete_TypeRef());
        if axes_ref.is_null() {
            return ct_font;
        }
        let axes: CFArray<CFDictionary> = TCFType::wrap_under_create_rule(axes_ref);
        let mut vals: Vec<(CFString, CFNumber)> = Vec::with_capacity(variations.len() as usize);
        for axis in axes.iter() {
            if !axis.instance_of::<CFDictionary>() {
                return ct_font;
            }
            let tag_val = match axis.find(kCTFontVariationAxisIdentifierKey as *const _) {
                Some(tag_ptr) => {
                    let tag: CFNumber = TCFType::wrap_under_get_rule(tag_ptr as CFNumberRef);
                    if !tag.instance_of::<CFNumber>() {
                        return ct_font;
                    }
                    match tag.to_i64() {
                        Some(val) => val,
                        None => return ct_font,
                    }
                }
                None => return ct_font,
            };
            let mut val = match variations.iter().find(|variation| (variation.tag as i64) == tag_val) {
                Some(variation) => variation.value as f64,
                None => continue,
            };

            let name: CFString = match axis.find(kCTFontVariationAxisNameKey as *const _) {
                Some(name_ptr) => TCFType::wrap_under_get_rule(name_ptr as CFStringRef),
                None => return ct_font,
            };
            if !name.instance_of::<CFString>() {
                return ct_font;
            }

            let min_val = match axis.find(kCTFontVariationAxisMinimumValueKey as *const _) {
                Some(min_ptr) => {
                    let min: CFNumber = TCFType::wrap_under_get_rule(min_ptr as CFNumberRef);
                    if !min.instance_of::<CFNumber>() {
                        return ct_font;
                    }
                    match min.to_f64() {
                        Some(val) => val,
                        None => return ct_font,
                    }
                }
                None => return ct_font,
            };
            let max_val = match axis.find(kCTFontVariationAxisMaximumValueKey as *const _) {
                Some(max_ptr) => {
                    let max: CFNumber = TCFType::wrap_under_get_rule(max_ptr as CFNumberRef);
                    if !max.instance_of::<CFNumber>() {
                        return ct_font;
                    }
                    match max.to_f64() {
                        Some(val) => val,
                        None => return ct_font,
                    }
                }
                None => return ct_font,
            };
            let def_val = match axis.find(kCTFontVariationAxisDefaultValueKey as *const _) {
                Some(def_ptr) => {
                    let def: CFNumber = TCFType::wrap_under_get_rule(def_ptr as CFNumberRef);
                    if !def.instance_of::<CFNumber>() {
                        return ct_font;
                    }
                    match def.to_f64() {
                        Some(val) => val,
                        None => return ct_font,
                    }
                }
                None => return ct_font,
            };

            val = val.max(min_val).min(max_val);
            if val != def_val {
                vals.push((name, CFNumber::from(val)));
            }
        }
        if vals.is_empty() {
            return ct_font;
        }
        let vals_dict = CFDictionary::from_CFType_pairs(&vals);
        let cg_var_font = cg_font.create_copy_from_variations(&vals_dict).unwrap();
        core_text::font::new_from_CGFont_with_variations(&cg_var_font, size, &vals_dict)
    }
}

fn is_bitmap_font(ct_font: &CTFont) -> bool {
    let traits = ct_font.symbolic_traits();
    (traits & kCTFontColorGlyphsTrait) != 0
}

// Skew factor matching Gecko/CG.
const OBLIQUE_SKEW_FACTOR: f32 = 0.25;

impl FontContext {
    pub fn new() -> Result<FontContext, ResourceCacheError> {
        debug!("Test for subpixel AA support: {}", supports_subpixel_aa());

        // Force CG to use sRGB color space to gamma correct.
        let contrast = 0.0;
        let gamma = 0.0;

        Ok(FontContext {
            cg_fonts: FastHashMap::default(),
            ct_fonts: FastHashMap::default(),
            gamma_lut: GammaLut::new(contrast, gamma, gamma),
        })
    }

    pub fn has_font(&self, font_key: &FontKey) -> bool {
        self.cg_fonts.contains_key(font_key)
    }

    pub fn add_raw_font(&mut self, font_key: &FontKey, bytes: Arc<Vec<u8>>, index: u32) {
        if self.cg_fonts.contains_key(font_key) {
            return;
        }

        assert_eq!(index, 0);
        let data_provider = CGDataProvider::from_buffer(bytes);
        let cg_font = match CGFont::from_data_provider(data_provider) {
            Err(_) => return,
            Ok(cg_font) => cg_font,
        };
        self.cg_fonts.insert(*font_key, cg_font);
    }

    pub fn add_native_font(&mut self, font_key: &FontKey, native_font_handle: NativeFontHandle) {
        if self.cg_fonts.contains_key(font_key) {
            return;
        }

        self.cg_fonts
            .insert(*font_key, native_font_handle.0);
    }

    pub fn delete_font(&mut self, font_key: &FontKey) {
        if let Some(_) = self.cg_fonts.remove(font_key) {
            self.ct_fonts.retain(|k, _| k.0 != *font_key);
        }
    }

    fn get_ct_font(
        &mut self,
        font_key: FontKey,
        size: Au,
        variations: &[FontVariation],
    ) -> Option<CTFont> {
        match self.ct_fonts.entry((font_key, size, variations.to_vec())) {
            Entry::Occupied(entry) => Some((*entry.get()).clone()),
            Entry::Vacant(entry) => {
                let cg_font = match self.cg_fonts.get(&font_key) {
                    None => return None,
                    Some(cg_font) => cg_font,
                };
                let ct_font = new_ct_font_with_variations(cg_font, size.to_f64_px(), variations);
                entry.insert(ct_font.clone());
                Some(ct_font)
            }
        }
    }

    pub fn get_glyph_index(&mut self, font_key: FontKey, ch: char) -> Option<u32> {
        let character = ch as u16;
        let mut glyph = 0;

        self.get_ct_font(font_key, Au::from_px(16), &[])
            .and_then(|ref ct_font| {
                let result = ct_font.get_glyphs_for_characters(&character, &mut glyph, 1);

                if result {
                    Some(glyph as u32)
                } else {
                    None
                }
            })
    }

    pub fn get_glyph_dimensions(
        &mut self,
        font: &FontInstance,
        key: &GlyphKey,
    ) -> Option<GlyphDimensions> {
        self.get_ct_font(font.font_key, font.size, &font.variations)
            .and_then(|ref ct_font| {
                let glyph = key.index as CGGlyph;
                let bitmap = is_bitmap_font(ct_font);
                let (x_offset, y_offset) = if bitmap { (0.0, 0.0) } else { font.get_subpx_offset(key) };
                let transform = if font.flags.intersects(FontInstanceFlags::SYNTHETIC_ITALICS |
                                                         FontInstanceFlags::TRANSPOSE |
                                                         FontInstanceFlags::FLIP_X |
                                                         FontInstanceFlags::FLIP_Y) {
                    let mut shape = FontTransform::identity();
                    if font.flags.contains(FontInstanceFlags::FLIP_X) {
                        shape = shape.flip_x();
                    }
                    if font.flags.contains(FontInstanceFlags::FLIP_Y) {
                        shape = shape.flip_y();
                    }
                    if font.flags.contains(FontInstanceFlags::TRANSPOSE) {
                        shape = shape.swap_xy();
                    }
                    if font.flags.contains(FontInstanceFlags::SYNTHETIC_ITALICS) {
                        shape = shape.synthesize_italics(OBLIQUE_SKEW_FACTOR);
                    }
                    Some(CGAffineTransform {
                        a: shape.scale_x as f64,
                        b: -shape.skew_y as f64,
                        c: -shape.skew_x as f64,
                        d: shape.scale_y as f64,
                        tx: 0.0,
                        ty: 0.0,
                    })
                } else {
                    None
                };
                let extra_strikes = font.get_extra_strikes(1.0);
                let metrics = get_glyph_metrics(
                    ct_font,
                    transform.as_ref(),
                    glyph,
                    x_offset,
                    y_offset,
                    extra_strikes as f64,
                );
                if metrics.rasterized_width == 0 || metrics.rasterized_height == 0 {
                    None
                } else {
                    Some(GlyphDimensions {
                        left: metrics.rasterized_left,
                        top: metrics.rasterized_ascent,
                        width: metrics.rasterized_width as u32,
                        height: metrics.rasterized_height as u32,
                        advance: metrics.advance,
                    })
                }
            })
    }

    // Assumes the pixels here are linear values from CG
    #[cfg(not(feature = "pathfinder"))]
    fn gamma_correct_pixels(
        &self,
        pixels: &mut Vec<u8>,
        render_mode: FontRenderMode,
        color: ColorU,
    ) {
        // Then convert back to gamma corrected values.
        match render_mode {
            FontRenderMode::Alpha => {
                self.gamma_lut.preblend_grayscale(pixels, color);
            }
            FontRenderMode::Subpixel => {
                self.gamma_lut.preblend(pixels, color);
            }
            _ => {} // Again, give mono untouched since only the alpha matters.
        }
    }

    #[allow(dead_code)]
    fn print_glyph_data(&mut self, data: &[u8], width: usize, height: usize) {
        // Rust doesn't have step_by support on stable :(
        println!("Width is: {:?} height: {:?}", width, height);
        for i in 0 .. height {
            let current_height = i * width * 4;

            for pixel in data[current_height .. current_height + (width * 4)].chunks(4) {
                let b = pixel[0];
                let g = pixel[1];
                let r = pixel[2];
                let a = pixel[3];
                print!("({}, {}, {}, {}) ", r, g, b, a);
            }
            println!();
        }
    }

    pub fn prepare_font(font: &mut FontInstance) {
        match font.render_mode {
            FontRenderMode::Mono => {
                // In mono mode the color of the font is irrelevant.
                font.color = ColorU::new(255, 255, 255, 255);
                // Subpixel positioning is disabled in mono mode.
                font.disable_subpixel_position();
            }
            FontRenderMode::Alpha => {
                font.color = if font.flags.contains(FontInstanceFlags::FONT_SMOOTHING) {
                    // Only the G channel is used to index grayscale tables,
                    // so use R and B to preserve light/dark determination.
                    let ColorU { g, a, .. } = font.color.luminance_color().quantized_ceil();
                    let rb = if should_use_white_on_black(font.color) { 255 } else { 0 };
                    ColorU::new(rb, g, rb, a)
                } else {
                    ColorU::new(255, 255, 255, 255)
                };
            }
            FontRenderMode::Subpixel => {
                // Quantization may change the light/dark determination, so quantize in the
                // direction necessary to respect the threshold.
                font.color = if should_use_white_on_black(font.color) {
                    font.color.quantized_ceil()
                } else {
                    font.color.quantized_floor()
                };
            }
        }
    }

    #[cfg(not(feature = "pathfinder"))]
    pub fn rasterize_glyph(&mut self, font: &FontInstance, key: &GlyphKey) -> GlyphRasterResult {
        let (x_scale, y_scale) = font.transform.compute_scale().unwrap_or((1.0, 1.0));
        let scale = font.oversized_scale_factor(x_scale, y_scale);
        let size = font.size.scale_by((y_scale / scale) as f32);
        let ct_font = match self.get_ct_font(font.font_key, size, &font.variations) {
            Some(font) => font,
            None => return GlyphRasterResult::LoadFailed,
        };

        let bitmap = is_bitmap_font(&ct_font);
        let (mut shape, (x_offset, y_offset)) = if bitmap {
            (FontTransform::identity(), (0.0, 0.0))
        } else {
            (font.transform.invert_scale(y_scale, y_scale), font.get_subpx_offset(key))
        };
        if font.flags.contains(FontInstanceFlags::FLIP_X) {
            shape = shape.flip_x();
        }
        if font.flags.contains(FontInstanceFlags::FLIP_Y) {
            shape = shape.flip_y();
        }
        if font.flags.contains(FontInstanceFlags::TRANSPOSE) {
            shape = shape.swap_xy();
        }
        if font.flags.contains(FontInstanceFlags::SYNTHETIC_ITALICS) {
            shape = shape.synthesize_italics(OBLIQUE_SKEW_FACTOR);
        }
        let transform = if !shape.is_identity() {
            Some(CGAffineTransform {
                a: shape.scale_x as f64,
                b: -shape.skew_y as f64,
                c: -shape.skew_x as f64,
                d: shape.scale_y as f64,
                tx: 0.0,
                ty: 0.0,
            })
        } else {
            None
        };

        let glyph = key.index as CGGlyph;
        let (strike_scale, pixel_step) = if bitmap { (y_scale, 1.0) } else { (x_scale, y_scale / x_scale) };
        let extra_strikes = font.get_extra_strikes(strike_scale / scale);
        let metrics = get_glyph_metrics(
            &ct_font,
            transform.as_ref(),
            glyph,
            x_offset,
            y_offset,
            extra_strikes as f64 * pixel_step,
        );
        if metrics.rasterized_width == 0 || metrics.rasterized_height == 0 {
            return GlyphRasterResult::LoadFailed
        }

        // The result of this function, in all render modes, is going to be a
        // BGRA surface with white text on transparency using premultiplied
        // alpha. For subpixel text, the RGB values will be the mask value for
        // the individual components. For bitmap glyphs, the RGB values will be
        // the (premultiplied) color of the pixel. For Alpha and Mono, each
        // pixel will have R==G==B==A at the end of this function.
        // We access the color channels in little-endian order.
        // The CGContext will create and own our pixel buffer.
        // In the non-Bitmap cases, we will ask CoreGraphics to draw text onto
        // an opaque background. In order to hit the most efficient path in CG
        // for this, we will tell CG that the CGContext is opaque, by passing
        // an "[...]AlphaNone[...]" context flag. This creates a slight
        // contradiction to the way we use the buffer after CG is done with it,
        // because we will convert it into text-on-transparency. But that's ok;
        // we still get four bytes per pixel and CG won't mess with the alpha
        // channel after we've stopped calling CG functions. We just need to
        // make sure that we don't look at the alpha values of the pixels that
        // we get from CG, and compute our own alpha value only from RGB.
        // Note that CG requires kCGBitmapByteOrder32Little in order to do
        // subpixel AA at all (which we need it to do in both Subpixel and
        // Alpha+smoothing mode). But little-endian is what we want anyway, so
        // this works out nicely.
        let context_flags = if bitmap {
            kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst
        } else {
            kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst
        };

        let mut cg_context = CGContext::create_bitmap_context(
            None,
            metrics.rasterized_width as usize,
            metrics.rasterized_height as usize,
            8,
            metrics.rasterized_width as usize * 4,
            &CGColorSpace::create_device_rgb(),
            context_flags,
        );

        // If the font render mode is Alpha, we support two different ways to
        // compute the grayscale mask, depending on the value of the platform
        // options' font_smoothing flag:
        //  - Alpha + smoothing:
        //    We will recover a grayscale mask from a subpixel rasterization, in
        //    such a way that the result looks as close to subpixel text
        //    blending as we can make it. This involves gamma correction,
        //    luminance computations and preblending based on the text color,
        //    just like with the Subpixel render mode.
        //  - Alpha without smoothing:
        //    We will ask CoreGraphics to rasterize the text with font_smoothing
        //    off. This will cause it to use grayscale anti-aliasing with
        //    comparatively thin text. This method of text rendering is not
        //    gamma-aware.
        //
        // For subpixel rasterization, starting with macOS 10.11, CoreGraphics
        // uses different glyph dilation based on the text color. Bright text
        // uses less font dilation (looks thinner) than dark text.
        // As a consequence, when we ask CG to rasterize with subpixel AA, we
        // will render white-on-black text as opposed to black-on-white text if
        // the text color brightness exceeds a certain threshold. This applies
        // to both the Subpixel and the "Alpha + smoothing" modes, but not to
        // the "Alpha without smoothing" and Mono modes.
        let use_white_on_black = should_use_white_on_black(font.color);
        let use_font_smoothing = font.flags.contains(FontInstanceFlags::FONT_SMOOTHING);
        let (antialias, smooth, text_color, bg_color, bg_alpha, invert) = if bitmap {
            (true, false, 0.0, 0.0, 0.0, false)
        } else {
            match (font.render_mode, use_font_smoothing) {
                (FontRenderMode::Subpixel, _) |
                (FontRenderMode::Alpha, true) => if use_white_on_black {
                    (true, true, 1.0, 0.0, 1.0, false)
                } else {
                    (true, true, 0.0, 1.0, 1.0, true)
                },
                (FontRenderMode::Alpha, false) => (true, false, 0.0, 1.0, 1.0, true),
                (FontRenderMode::Mono, _) => (false, false, 0.0, 1.0, 1.0, true),
            }
        };

        // These are always true in Gecko, even for non-AA fonts
        cg_context.set_allows_font_subpixel_positioning(true);
        cg_context.set_should_subpixel_position_fonts(true);

        // Don't quantize because we're doing it already.
        cg_context.set_allows_font_subpixel_quantization(false);
        cg_context.set_should_subpixel_quantize_fonts(false);

        cg_context.set_should_smooth_fonts(smooth);
        cg_context.set_should_antialias(antialias);

        // Fill the background. This could be opaque white, opaque black, or
        // transparency.
        cg_context.set_rgb_fill_color(bg_color, bg_color, bg_color, bg_alpha);
        let rect = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize {
                width: metrics.rasterized_width as f64,
                height: metrics.rasterized_height as f64,
            },
        };
        cg_context.fill_rect(rect);

        // Set the text color and draw the glyphs.
        cg_context.set_rgb_fill_color(text_color, text_color, text_color, 1.0);
        cg_context.set_text_drawing_mode(CGTextDrawingMode::CGTextFill);

        // CG Origin is bottom left, WR is top left. Need -y offset
        let mut draw_origin = CGPoint {
            x: -metrics.rasterized_left as f64 + x_offset,
            y: metrics.rasterized_descent as f64 - y_offset,
        };

        if let Some(transform) = transform {
            cg_context.set_text_matrix(&transform);

            draw_origin = draw_origin.apply_transform(&transform.invert());
        }

        if extra_strikes > 0 {
            let strikes = 1 + extra_strikes;
            let glyphs = vec![glyph; strikes];
            let origins = (0..strikes)
                .map(|i| CGPoint { x: draw_origin.x + i as f64 * pixel_step, y: draw_origin.y })
                .collect::<Vec<_>>();
            ct_font.draw_glyphs(&glyphs, &origins, cg_context.clone());
        } else {
            ct_font.draw_glyphs(&[glyph], &[draw_origin], cg_context.clone());
        }

        let mut rasterized_pixels = cg_context.data().to_vec();

        if !bitmap {
            // We rendered text into an opaque surface. The code below needs to
            // ignore the current value of each pixel's alpha channel. But it's
            // allowed to write to the alpha channel, because we're done calling
            // CG functions now.

            if smooth {
                // Convert to linear space for subpixel AA.
                // We explicitly do not do this for grayscale AA ("Alpha without
                // smoothing" or Mono) because those rendering modes are not
                // gamma-aware in CoreGraphics.
                self.gamma_lut.coregraphics_convert_to_linear(
                    &mut rasterized_pixels,
                );
            }

            for pixel in rasterized_pixels.chunks_mut(4) {
                if invert {
                    pixel[0] = 255 - pixel[0];
                    pixel[1] = 255 - pixel[1];
                    pixel[2] = 255 - pixel[2];
                }

                // Set alpha to the value of the green channel. For grayscale
                // text, all three channels have the same value anyway.
                // For subpixel text, the mask's alpha only makes a difference
                // when computing the destination alpha on destination pixels
                // that are not completely opaque. Picking an alpha value
                // that's somehow based on the mask at least ensures that text
                // blending doesn't modify the destination alpha on pixels where
                // the mask is entirely zero.
                pixel[3] = pixel[1];
            }

            if smooth {
                // Convert back from linear space into device space, and perform
                // some "preblending" based on the text color.
                // In Alpha + smoothing mode, this will also convert subpixel AA
                // into grayscale AA.
                self.gamma_correct_pixels(
                    &mut rasterized_pixels,
                    font.render_mode,
                    font.color,
                );
            }
        }

        GlyphRasterResult::Bitmap(RasterizedGlyph {
            left: metrics.rasterized_left as f32,
            top: metrics.rasterized_ascent as f32,
            width: metrics.rasterized_width,
            height: metrics.rasterized_height,
            scale: (if bitmap { scale / y_scale } else { scale }) as f32,
            format: if bitmap { GlyphFormat::ColorBitmap } else { font.get_glyph_format() },
            bytes: rasterized_pixels,
        })
    }
}

#[cfg(feature = "pathfinder")]
impl<'a> Into<CGFont> for NativeFontHandleWrapper<'a> {
    fn into(self) -> CGFont {
        (self.0).0.clone()
    }
}
