import vm from "node:vm";
import * as ts from "typescript";
import { type NextApiHandler } from "next";
import { createElement } from "react";
import * as ReactServerDOM from "react-server-dom-webpack/server.node";
import { generateNewComponentStreaming } from "~/server/openai";
import { TransformStream, ReadableStream } from "node:stream/web";
// @todo figure out how to use this from the ai package.. the exports map returns exports.rsc.import rather than exports.rsc.react-server
import { createStreamableUI } from "~/utils/ai";
import { pipeline, Transform } from "node:stream";

export const config = {
  // @todo this should be controlled by an environment variable.
  // The same variable is used to respond with a stream or a regular response when generation is complete.
  supportsResponseStreaming: true,
};

// JSX is transformed to JSX_FACTORY_NAME() calls.
const JSX_FACTORY_NAME = "___$rs$jsx";

type ClientComponentId = string;
type ClientComponentBundlePath = string;
type ClientComponentNamedExportName = string;
// ClientComponentMetadata are used to fetch and mount the component on the client.
// Note for future reference:
//     it seems that newer version of `react-server-dom-webpack`
//     use an array format rather than objects:
//     [id, chunks, name, async]
type ClientComponentMetadata = {
  id: ClientComponentBundlePath;
  name: ClientComponentNamedExportName;
  chunks: [];
  async: true;
};

type ClientComponentsMap = Record<ClientComponentId, ClientComponentMetadata>;

const handler: NextApiHandler = async (request, response) => {
  const prompt = request.query.p;

  if (!prompt) {
    return response.status(400).end();
  }

  const clientComponentsMap: ClientComponentsMap = {};

  const uiStream = createStreamableUI(<></>);

  const { pipe } = ReactServerDOM.renderToPipeableStream(
    uiStream.value,
    clientComponentsMap,
  );

  // This doesn't seem strictly necessary.
  response.setHeader("content-type", "text/x-component");

  let jsxCode = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Transform the RSC payload stream to a stream of
  // { rsc, jsx } so that the client gets both the RSC payload
  // and the raw JSX string to render the code to copy/paste
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      const rsc = decoder.decode(chunk);

      callback(
        null,
        encoder.encode(
          JSON.stringify({
            rsc,
            jsx: jsxCode,
            // @todo extract external components imports and add them here
          }),
        ),
      );
    },
  });

  pipe(transform);
  transform.pipe(response);

  // (test) simulate LLM stream.
  const aiStream = getTestAIStream();
  // const aiStream = await generateNewComponentStreaming(prompt);

  // Consume the aiStream:
  // - Accumulate JSX
  // - Parse and evaluate it to React
  // - update the uiStream (flush to the client)
  (async () => {
    const reader = aiStream.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        uiStream.done();
        break;
      }

      jsxCode += decoder.decode(value);
      jsxCode = jsxCode.replace(/jsx/, "").replace(/```\s*$/, "");

      try {
        const reactTree = await evaluate(
          transformJsx(jsxCode),
          clientComponentsMap,
        );
        if (reactTree) {
          uiStream.update(reactTree);
        }
      } catch (error) {
        continue;
      }
    }
  })();
};

export default handler;

// A map of supported design system components.
// These are compiled React Client Components esported as named export
// eg export const Counter = () => {...}
const availableClientComponents = {
  Counter: createTestClientComponent("__client.Counter"),
};
function createTestClientComponent(id: ClientComponentId) {
  function Component() {}
  Component.$$typeof = Symbol.for("react.client.reference");
  Component.$$id = id;
  Component.$$path = "/g/test.js";
  return Component;
}

async function evaluate(
  code: string,
  clientComponentsMap: ClientComponentsMap,
) {
  const script = new vm.Script(code);

  const context = new Proxy(
    {
      [JSX_FACTORY_NAME]: createElement,
    },
    {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in availableClientComponents) {
          const component =
            availableClientComponents[
              prop as keyof typeof availableClientComponents
            ];

          if (component.$$id in clientComponentsMap === false) {
            // [id, chunks, name, async]
            // clientComponentsMap[t] = [`/g/test.js`, [], t, true];
            clientComponentsMap[component.$$id] = {
              id: component.$$path,
              // Use the detected export name
              name: prop,
              // Turn off chunks. This is webpack-specific
              chunks: [],
              // Use an async import for the built resource in the browser
              async: true,
            };
          }

          return component;
        }

        return Reflect.get(target, prop, receiver);
      },
    },
  );

  // @todo figure out how to sandbox, limiting what can be imported by the evaluated code.
  vm.createContext(context);

  return script.runInContext(context);
}

function transformJsx(jsx: string): string {
  return ts.transpileModule(jsx, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: "react",
      jsxFactory: JSX_FACTORY_NAME,
    },
  }).outputText;
}

const stateful = `<Counter />`;

const source = `
<div className="min-h-screen bg-red-500 text-white">
  <div className="w-full max-w-2xl mx-auto py-10 flex flex-col gap-4">
    <h1 className="font-medium text-2xl">Truly Generative UI</h1>
    <p>No framework, standalone React Server Components stream-rendering UI as the LLM generates it 🤌</p>
    <div className="rounded-md bg-blue-700 w-full h-32 flex justify-center items-center">later</div>
    ${stateful}
    <div className="rounded-md bg-green-700 w-full h-32 flex justify-center items-center">done</div>
  </div>
</div>`.trim();

function getTestAIStream({
  chunksAmount = 5,
  slowdown = 1000,
}: {
  chunksAmount?: number;
  slowdown?: number;
} = {}) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const len = Math.floor(source.length / chunksAmount);
      const chunks = new Array(chunksAmount)
        .fill(null)
        .map((_, i) =>
          source.slice(
            i * len,
            i === chunksAmount - 1 ? source.length : (i + 1) * len,
          ),
        );

      for (const chunk of chunks) {
        await sleep(slowdown);
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
