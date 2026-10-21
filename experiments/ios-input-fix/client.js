(function() {
	//#region experiments/ios-input-fix/src/viewport.js
	/** Viewport geometry and event ownership without DOM mutations. */
	/**
	* Read an unzoomed visible rectangle; null means retain the previous layout during user zoom.
	* @param {object} viewport - Browser VisualViewport measurements in CSS pixels.
	* @returns {object|null} Visible rectangle, or null during zoom or an empty transition frame.
	*/
	function viewportFrame(viewport) {
		if (Math.abs(viewport.scale - 1) > .01 || viewport.width <= 0 || viewport.height <= 0) return null;
		return {
			width: viewport.width,
			height: viewport.height,
			top: viewport.offsetTop,
			left: viewport.offsetLeft
		};
	}
	/**
	* Publish at most once per animation frame and cancel all owned work on disposal.
	* @param {object} source - Viewport/page event targets, frame scheduling and a current-value reader.
	* @param {Function} publish - Receives each current value, including the initial one.
	* @returns {Function} Removes listeners and cancels an outstanding frame.
	*/
	function watchViewport(source, publish) {
		let frame = null;
		const update = () => {
			frame = null;
			publish(source.read());
		};
		const schedule = () => {
			if (frame === null) frame = source.requestFrame(update);
		};
		const events = [
			[source.viewport, "resize"],
			[source.viewport, "scroll"],
			[source.page, "resize"],
			[source.page, "orientationchange"],
			[source.page, "pageshow"]
		];
		for (const [target, name] of events) target.addEventListener(name, schedule);
		update();
		return () => {
			for (const [target, name] of events) target.removeEventListener(name, schedule);
			if (frame !== null) source.cancelFrame(frame);
		};
	}
	//#endregion
	//#region experiments/ios-input-fix/src/client.js
	/** iOS input font floor and keyboard-aware app sizing, owned by one shell slot. */
	window.__ModuleLoader__.load({
		id: "@local/dsh-ios-input-fix",
		factory(require) {
			const React = require("react");
			return {
				inject: ["slots"],
				apply(ctx) {
					function InputViewportStyles() {
						const [frame, setFrame] = React.useState(null);
						React.useLayoutEffect(() => {
							if (!CSS.supports("-webkit-touch-callout", "none") || !window.matchMedia("(any-pointer: coarse)").matches) return;
							const viewport = window.visualViewport;
							if (viewport === null || viewport === void 0) return;
							return watchViewport({
								viewport,
								page: window,
								requestFrame: (callback) => window.requestAnimationFrame(callback),
								cancelFrame: (id) => window.cancelAnimationFrame(id),
								read: () => viewportFrame(viewport)
							}, (next) => {
								if (next === null) return;
								setFrame((previous) => previous !== null && previous.width === next.width && previous.height === next.height && previous.top === next.top && previous.left === next.left ? previous : next);
							});
						}, []);
						const root = frame === null ? "" : `
            #root {
              position: fixed;
              top: ${frame.top}px;
              left: ${frame.left}px;
              width: ${frame.width}px;
              height: ${frame.height}px;
              min-height: 0;
              box-sizing: border-box;
              padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
                env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
            }`;
						return React.createElement("style", { "data-ios-input-fix": "" }, `
            @supports (-webkit-touch-callout: none) {
              @media (any-pointer: coarse) {
                [data-composer-card] :is([data-composer-input], [data-composer-placeholder]) {
                  font-size: max(16px, var(--dsh-content-font-size, 14px));
                }
                ${root}
              }
            }`);
					}
					ctx.slots.inject("shell.overlay", () => ctx.slots.register({
						name: "shell.overlay",
						id: "ios-input-fix",
						order: 0
					}, InputViewportStyles));
				}
			};
		}
	});
	//#endregion
})();
