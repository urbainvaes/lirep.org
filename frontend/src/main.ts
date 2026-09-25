import { fetchMe, renderAuthArea } from "./layout";

fetchMe().then(renderAuthArea);
