import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";

renderMathInElement(document.querySelector("main") ?? document.body, {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\(", right: "\\)", display: false },
  ],
  throwOnError: false,
});
