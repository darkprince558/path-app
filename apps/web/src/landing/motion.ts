import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * GSAP for the landing page's scroll story (ScrollTrigger pins a section and ties
 * the animation to the scroll position, "scrub"). Every section writes its finished
 * state into the markup, and the animations only run when motion is allowed, so
 * Reduce motion simply shows the end result.
 */
gsap.registerPlugin(ScrollTrigger, useGSAP);

export { gsap, ScrollTrigger, useGSAP };

/** Wide enough for the side-by-side pinned layouts. */
export const WIDE = "(min-width: 768px)";
