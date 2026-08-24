#include <node_api.h>

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

constexpr CGFloat kMaxPreviewWidth = 320.0;
constexpr CGFloat kMaxPreviewHeight = 220.0;
constexpr CGFloat kHostInset = 24.0;
constexpr CGFloat kCornerRadius = 14.0;

@interface OperonPIPOverlayView : NSView
@end

@implementation OperonPIPOverlayView
- (BOOL)isOpaque {
  return NO;
}

- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

@interface OperonPIPHost : NSObject
@property(nonatomic, strong) NSView *parentView;
@property(nonatomic, strong) OperonPIPOverlayView *overlayView;
@property(nonatomic, strong) CALayer *shadowLayer;
@property(nonatomic, strong) CALayer *clipLayer;
@property(nonatomic, strong) CALayer *hostedLayer;
@property(nonatomic, assign) CGRect anchorRect;
@property(nonatomic, assign) CGSize sourceSize;
@property(nonatomic, assign) BOOL layoutVisible;
@property(nonatomic, assign) BOOL presentationReady;
- (BOOL)attachToNativeView:(NSView *)parentView;
- (BOOL)presentContextID:(uint32_t)contextID width:(CGFloat)width height:(CGFloat)height;
- (void)setAnchorX:(CGFloat)x
                  y:(CGFloat)y
              width:(CGFloat)width
             height:(CGFloat)height
            visible:(BOOL)visible;
- (void)setHostVisible:(BOOL)visible;
- (void)clearPresentation;
- (void)dispose;
- (void)updateGeometry;
- (void)reconcileVisibility;
@end

@implementation OperonPIPHost

- (BOOL)attachToNativeView:(NSView *)parentView {
  if (parentView == nil) {
    return NO;
  }
  if (self.parentView == parentView && self.overlayView.superview == parentView) {
    return YES;
  }

  [self.overlayView removeFromSuperview];
  self.parentView = parentView;

  OperonPIPOverlayView *overlay = [[OperonPIPOverlayView alloc] initWithFrame:NSZeroRect];
  overlay.wantsLayer = YES;
  overlay.layer.backgroundColor = NSColor.clearColor.CGColor;
  overlay.layer.masksToBounds = NO;
  overlay.hidden = YES;

  CALayer *shadow = [CALayer layer];
  shadow.backgroundColor = NSColor.clearColor.CGColor;
  shadow.shadowColor = NSColor.blackColor.CGColor;
  shadow.shadowOpacity = 0.22;
  shadow.shadowRadius = 12.0;
  shadow.shadowOffset = CGSizeMake(0, -5.0);

  CALayer *clip = [CALayer layer];
  clip.backgroundColor = NSColor.clearColor.CGColor;
  clip.cornerRadius = kCornerRadius;
  if (@available(macOS 10.15, *)) {
    clip.cornerCurve = kCACornerCurveContinuous;
  }
  clip.masksToBounds = YES;

  [overlay.layer addSublayer:shadow];
  [overlay.layer addSublayer:clip];
  [parentView addSubview:overlay positioned:NSWindowAbove relativeTo:nil];

  self.overlayView = overlay;
  self.shadowLayer = shadow;
  self.clipLayer = clip;
  self.hostedLayer = nil;
  self.presentationReady = NO;
  [self updateGeometry];
  return YES;
}

- (BOOL)presentContextID:(uint32_t)contextID width:(CGFloat)width height:(CGFloat)height {
  if (contextID == 0 || width <= 0 || height <= 0 || self.clipLayer == nil) {
    return NO;
  }
  Class layerHostClass = NSClassFromString(@"CALayerHost");
  if (layerHostClass == Nil) {
    return NO;
  }

  CALayer *hosted = self.hostedLayer;
  if (hosted == nil) {
    hosted = [layerHostClass layer];
    [hosted setValue:@YES forKey:@"preservesFlip"];
    [hosted setValue:@YES forKey:@"resizesHostedContext"];
    [self.clipLayer addSublayer:hosted];
    self.hostedLayer = hosted;
  }
  [hosted setValue:@(contextID) forKey:@"contextId"];
  self.sourceSize = CGSizeMake(width, height);
  self.presentationReady = YES;
  [self updateGeometry];
  [self reconcileVisibility];
  return YES;
}

- (void)setAnchorX:(CGFloat)x
                  y:(CGFloat)y
              width:(CGFloat)width
             height:(CGFloat)height
            visible:(BOOL)visible {
  self.anchorRect = CGRectMake(x, y, width, height);
  self.layoutVisible = visible && width > 0 && height > 0;
  [self updateGeometry];
  [self reconcileVisibility];
}

- (void)setHostVisible:(BOOL)visible {
  self.layoutVisible = visible && self.anchorRect.size.width > 0 && self.anchorRect.size.height > 0;
  [self reconcileVisibility];
}

- (void)clearPresentation {
  if (self.hostedLayer != nil) {
    [self.hostedLayer setValue:@0 forKey:@"contextId"];
    [self.hostedLayer removeFromSuperlayer];
    self.hostedLayer = nil;
  }
  self.presentationReady = NO;
  self.sourceSize = CGSizeZero;
  [self reconcileVisibility];
}

- (void)dispose {
  [self clearPresentation];
  [self.overlayView removeFromSuperview];
  self.overlayView = nil;
  self.shadowLayer = nil;
  self.clipLayer = nil;
  self.parentView = nil;
}

- (void)updateGeometry {
  if (self.parentView == nil || self.overlayView == nil || self.sourceSize.width <= 0 ||
      self.sourceSize.height <= 0 || self.anchorRect.size.width <= 0 ||
      self.anchorRect.size.height <= 0) {
    return;
  }

  CGFloat scale = MIN(1.0, MIN(kMaxPreviewWidth / self.sourceSize.width,
                               kMaxPreviewHeight / self.sourceSize.height));
  CGFloat width = MAX(1.0, round(self.sourceSize.width * scale));
  CGFloat height = MAX(1.0, round(self.sourceSize.height * scale));
  width = MIN(width, MAX(1.0, self.anchorRect.size.width - 2.0 * kHostInset));
  height = MIN(height, MAX(1.0, self.anchorRect.size.height - 2.0 * kHostInset));

  CGFloat top = self.anchorRect.origin.y + kHostInset;
  CGFloat x = CGRectGetMaxX(self.anchorRect) - width - kHostInset;
  CGFloat y = NSHeight(self.parentView.bounds) - top - height;
  x = MAX(NSMinX(self.parentView.bounds), x);
  y = MAX(NSMinY(self.parentView.bounds), y);

  CGRect frame = CGRectMake(round(x), round(y), round(width), round(height));
  self.overlayView.frame = frame;
  self.shadowLayer.frame = self.overlayView.bounds;
  self.shadowLayer.shadowPath = [NSBezierPath bezierPathWithRoundedRect:self.overlayView.bounds
                                                               xRadius:kCornerRadius
                                                               yRadius:kCornerRadius].CGPath;
  self.clipLayer.frame = self.overlayView.bounds;
  self.hostedLayer.frame = self.clipLayer.bounds;
}

- (void)reconcileVisibility {
  BOOL shouldShow = self.layoutVisible && self.presentationReady && self.parentView.window != nil;
  if (shouldShow == !self.overlayView.hidden) {
    return;
  }
  if (shouldShow) {
    self.overlayView.alphaValue = 0;
    self.overlayView.hidden = NO;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.14;
      context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
      self.overlayView.animator.alphaValue = 1;
    } completionHandler:nil];
  } else {
    self.overlayView.hidden = YES;
    self.overlayView.alphaValue = 1;
  }
}

@end

namespace {

OperonPIPHost *SharedHost() {
  static OperonPIPHost *host = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    host = [[OperonPIPHost alloc] init];
  });
  return host;
}

void OnMainSync(dispatch_block_t block) {
  if (NSThread.isMainThread) {
    block();
  } else {
    dispatch_sync(dispatch_get_main_queue(), block);
  }
}

void ThrowTypeError(napi_env env, const char *message) {
  napi_throw_type_error(env, nullptr, message);
}

bool ReadDouble(napi_env env, napi_value value, double *result) {
  return napi_get_value_double(env, value, result) == napi_ok;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1) {
    ThrowTypeError(env, "attach requires a native window handle Buffer");
    return nullptr;
  }

  bool isBuffer = false;
  napi_is_buffer(env, argv[0], &isBuffer);
  void *data = nullptr;
  size_t length = 0;
  if (!isBuffer || napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok ||
      length < sizeof(uintptr_t)) {
    ThrowTypeError(env, "native window handle must contain a pointer");
    return nullptr;
  }

  uintptr_t pointer = 0;
  memcpy(&pointer, data, sizeof(pointer));
  __unsafe_unretained id nativeObject = (__bridge id)(reinterpret_cast<void *>(pointer));
  if (![nativeObject isKindOfClass:NSView.class]) {
    ThrowTypeError(env, "native window handle is not an NSView");
    return nullptr;
  }

  __block BOOL attached = NO;
  NSView *view = (NSView *)nativeObject;
  OnMainSync(^{ attached = [SharedHost() attachToNativeView:view]; });
  return Boolean(env, attached);
}

napi_value Present(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double contextID = 0;
  double width = 0;
  double height = 0;
  if (argc != 3 || !ReadDouble(env, argv[0], &contextID) || !ReadDouble(env, argv[1], &width) ||
      !ReadDouble(env, argv[2], &height) || contextID <= 0 || contextID > UINT32_MAX) {
    ThrowTypeError(env, "present requires contextID, width, and height");
    return nullptr;
  }

  __block BOOL presented = NO;
  OnMainSync(^{
    presented = [SharedHost() presentContextID:static_cast<uint32_t>(contextID)
                                          width:width
                                         height:height];
  });
  return Boolean(env, presented);
}

napi_value SetAnchorRect(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  bool visible = false;
  if (argc != 5 || !ReadDouble(env, argv[0], &x) || !ReadDouble(env, argv[1], &y) ||
      !ReadDouble(env, argv[2], &width) || !ReadDouble(env, argv[3], &height) ||
      napi_get_value_bool(env, argv[4], &visible) != napi_ok) {
    ThrowTypeError(env, "setAnchorRect requires x, y, width, height, and visible");
    return nullptr;
  }
  OnMainSync(^{ [SharedHost() setAnchorX:x y:y width:width height:height visible:visible]; });
  return Boolean(env, true);
}

napi_value SetVisible(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool visible = false;
  if (argc != 1 || napi_get_value_bool(env, argv[0], &visible) != napi_ok) {
    ThrowTypeError(env, "setVisible requires a boolean");
    return nullptr;
  }
  OnMainSync(^{ [SharedHost() setHostVisible:visible]; });
  return Boolean(env, true);
}

napi_value Clear(napi_env env, napi_callback_info info) {
  OnMainSync(^{ [SharedHost() clearPresentation]; });
  return Boolean(env, true);
}

napi_value Dispose(napi_env env, napi_callback_info info) {
  OnMainSync(^{ [SharedHost() dispose]; });
  return Boolean(env, true);
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"present", nullptr, Present, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setAnchorRect", nullptr, SetAnchorRect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setVisible", nullptr, SetVisible, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"clear", nullptr, Clear, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
