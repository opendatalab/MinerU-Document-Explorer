import json
import re
import base64
import logging
import ast
from io import BytesIO
from typing import Any, Dict, List, Optional
from PIL import Image

import httpx
from openai import OpenAI
from doc_search.backends.mineru_tool import ImageZoomOCRTool
from doc_search.pdf_utils import local_image_to_data_url

logger = logging.getLogger(__name__)

TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(.*?)\s*</tool_call>",
    re.DOTALL,
)

SYSTEM_PROMPT = """You are an advanced Visual Document Analysis Agent capable of precise evidence extraction from document images. Your goal is to answer user queries by locating, reading, and extracting specific information from a page.

### Your Capabilities & Tools

You have access to a powerful tool named **`image_zoom_and_ocr_tool`**.

* **Functionality**:
  Crop a specific region of the image, optionally rotate it, and perform OCR or layout analysis depending on the element type.

* **When to use**:

  * Always use this tool when the user asks for **specific text, numbers, names, dates, tables, equations, images, or factual details** from the page.
  * If the target text or table is rotated, estimate and set the `angle` parameter before cropping.
  * Use `type` to indicate the content type for the region:

    * `"region"` — perform layout detection + OCR on a potentially complex area, returning detailed structured information.
    * `"text"` — perform OCR for a single text element.
    * `"table"` — perform OCR and parsing for a table element.
    * `"image"` — crop the image region only, without OCR.
    * `"equation"` — perform OCR for mathematical or scientific equations.

* **Parameters**:

  * `label`: A short description of what you are looking for.
  * `bbox`: `[xmin, ymin, xmax, ymax]` in **0–1000 normalized coordinates**, relative to the original page.
  * `angle`: Rotation angle (counter-clockwise) applied after cropping. Always try to adjust it so the content is upright for best recognition.
  * `type`: One of `"region"`, `"text"`, `"table"`, `"image"`, `"equation"`.

### Tool Usage Example

Use the tool strictly in the following format:
<think>
...
</think>
<tool_call>
{"name": "image_zoom_and_ocr_tool", "arguments": {"label": "<A short description of what you are looking for>", "bbox": [xmin, ymin, xmax, ymax], "angle":<0/90/180/270>, "type": "<region/text/table/image/equation>"}}
</tool_call>

### Your Input and Task

The input includes:

1. One page image of a visual document.
2. The user's query intent.

Please execute the following steps:

1. **Semantic Matching**: Carefully observe the image to determine if the page content contains evidence information relevant to the user's query. If it is irrelevant, return an empty list.
2. **Precise Localization**: If relevant, extract the complete chain of visual evidence that helps to answer the query (text blocks, tables, charts, images, or equations).
3. **Special Notes**: The page image may contain several evidence pieces. Pay attention to tables, charts, images, and equations, as they could also contain evidence.

### Output Format

After gathering information, output the list of relevant evidence in the following JSON format.
<think>
...
</think>
```json
[
  {
    "evidence": "<self-contained content, understandable without page context>",
    "bbox": [xmin, ymin, xmax, ymax] # 0-1000 normalized coordinates
  }
  ...
]
```

If the page image is not relevant, return an empty list.
<think>
...
</think>
```json
[]
```
"""

class AgenticOCR:
    def __init__(self, base_url: str, api_key: str, model_name: str, tool, max_image_size: int = 2048):
        self.client = OpenAI(
            base_url=base_url,
            api_key=api_key,
            http_client=httpx.Client(trust_env=False),
        )
        self.model_name = model_name
        self.tool = tool
        self.max_image_size = max_image_size

    def compress_image(
        self,
        image_path: str,
        mode: str = "keep_ratio",
        target_size: int = 1000,
    ) -> str:
        """
        Compresses / Resizes an image and returns a base64 data URL.

        Modes:
        - keep_ratio: keep aspect ratio, longest side <= self.max_image_size
        - fixed: resize to (target_size, target_size)
        """
        try:
            with Image.open(image_path) as img:
                width, height = img.size

                if width > 3000 or height > 3000:
                    mode = "keep_ratio"

                if mode == "keep_ratio":
                    if max(width, height) > self.max_image_size:
                        scale = self.max_image_size / max(width, height)
                        new_width = int(width * scale)
                        new_height = int(height * scale)
                        img = img.resize(
                            (new_width, new_height),
                            Image.Resampling.LANCZOS
                        )

                elif mode == "fixed":
                    img = img.resize(
                        (target_size, target_size),
                        Image.Resampling.LANCZOS
                    )

                else:
                    raise ValueError(f"Unknown compress mode: {mode}")

                # Encode to base64
                buffered = BytesIO()
                fmt = "PNG" if img.mode == "RGBA" else "JPEG"
                img.save(buffered, format=fmt, quality=85, optimize=True)

                img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
                mime_type = f"image/{fmt.lower()}"

                return f"data:{mime_type};base64,{img_str}"

        except Exception:
            logger.exception("Failed to compress image: %s", image_path)
            return local_image_to_data_url(image_path)


    def build_multimodal_user_message(
        self,
        text: str,
        image_paths: Optional[List[str]] = None
    ) -> Dict:
        content = []

        if image_paths:
            for path in image_paths:
                # Use the compression method here
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": self.compress_image(path,mode="fixed")
                    }
                })

        if text:
            content.append({
                "type": "text",
                "text": text
            })

        return {
            "role": "user",
            "content": content
        }

    def build_multimodal_tool_message(
        self,
        text: Optional[str] = None,
        image_path: Optional[str] = None
    ) -> Dict:
        content = []
        content.append({
                "type": "text",
                "text": "<tool_response>\n"
            })

        if image_path:
            # Use the compression method here
            content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": self.compress_image(image_path,mode="keep_ratio")
                    }
                })

        if text:
            content.append({
                "type": "text",
                "text": f"\n{text}"
            })

        content.append({
                "type": "text",
                "text": "\n</tool_response>"
            })

        return {
            "role": "user",
            "content": content
        }
    def extract_tool_call(self,text: str):
        m = TOOL_CALL_RE.search(text)
        if not m:
            return None

        raw = m.group(1).strip()

        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None

        payload = raw[start:end + 1]

        try:
            return json.loads(payload)
        except Exception:
            try:
                return ast.literal_eval(payload)
            except Exception:
                return None

    # ---------- tool mock ----------

    def _handle_tool_call(self, tool_call, image_path, step, max_rounds) -> list:
        if step >= max_rounds - 2:
            return [False, "You have used up all the available uses of `image_zoom_and_ocr_tool`, please return your final response without using the tool."]

        result_list = self.tool.call(tool_call, image_path)

        if not result_list[0]:
            result_list = self.tool.call(tool_call, image_path)
            if not result_list[0]:
                return [False, "`image_zoom_and_ocr_tool` failed, you can try again."]

        if len(result_list) == 2:
            return [True, result_list[1]]

        if len(result_list) == 3:
            return [True, result_list[1], f"{result_list[2]}"]

        return result_list

    # ---------- agent loop ----------

    def run_agent(
        self,
        user_text: str,
        image_paths: Optional[List[str]] = None,
        max_rounds: int = 10,
        uid: int = 1
    ):
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            self.build_multimodal_user_message(user_text, image_paths),
        ]

        # Note: We store original paths in output log, but send compressed to model
        output = {
            "id": uid,
            "predictions": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "<image>\n" + user_text}
            ],
            "images": [image_paths[0]] if image_paths else []
        }

        for step in range(max_rounds):
            try:
                resp = self.client.chat.completions.create(
                    model=self.model_name,
                    messages=messages,
                    temperature=1.0
                )
            except Exception:
                logger.exception("API call failed at step %d", step)
                break

            content = resp.choices[0].message.content

            messages.append({"role": "assistant", "content": content})
            output["predictions"].append({"role": "assistant", "content": content})

            tool_call = self.extract_tool_call(content)

            # No tool call -> agent finished
            if tool_call is None:
                return output

            # Use original image path for tool execution (to preserve precision),
            # but the visual feedback to the model will be compressed inside build_multimodal_tool_message
            tool_response_list = self._handle_tool_call(tool_call, image_paths[0], step, max_rounds)
            success = tool_response_list[0]

            if not success:
                messages.append(
                    self.build_multimodal_tool_message(text=tool_response_list[1])
                )
                output["predictions"].append({"role": "user", "content": "<tool_response>\n" + tool_response_list[1] + "\n</tool_response>"})
            elif len(tool_response_list) == 2:
                messages.append(
                    self.build_multimodal_tool_message(image_path=tool_response_list[1])
                )
                output["predictions"].append({"role": "user", "content": "<tool_response>\n<image>\n</tool_response>"})
                output["images"].append(tool_response_list[1])
            elif len(tool_response_list) == 3:
                messages.append(
                    self.build_multimodal_tool_message(image_path=tool_response_list[1], text=tool_response_list[2])
                )
                output["predictions"].append({"role": "user", "content": "<tool_response>\n<image>\n" + tool_response_list[2] + "\n</tool_response>"})
                output["images"].append(tool_response_list[1])

        logger.warning("uid=%s exceeded max_rounds, dropping sample", uid)
        return None


# ---------------------------------------------------------------------------
# JSON extraction helpers
# ---------------------------------------------------------------------------

def _extract_json_array_string(text: str) -> str:
    """Extract a JSON array string from model output."""
    match = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1:
        return text[start : end + 1]
    return "[]"


def _execute_agent_and_parse_json(
    agent: Any,
    query: str,
    image_path: str,
    max_retry: int = 5,
    max_text_length: int = 40000,
) -> List[Any]:
    """Run the AgenticOCR agent and parse JSON list from the output."""
    try:
        retry_count = 0
        predictions: List[Dict[str, Any]] = []

        while retry_count < max_retry:
            agent_output = agent.run_agent(user_text=query, image_paths=[image_path])
            if not agent_output:
                return [1, 1]

            predictions = agent_output.get("predictions", [])
            if not predictions:
                return [1, 1]

            all_text = "".join(
                item.get("content", "")
                for item in predictions
                if isinstance(item, dict)
            )
            if len(all_text) <= max_text_length:
                break
            retry_count += 1

        last_msg_content = predictions[-1].get("content", "")
        json_str = _extract_json_array_string(last_msg_content)

        original_json_str = json_str
        try:
            extracted_data = json.loads(json_str)
        except Exception:
            json_str = json_str.replace("\n", "\\n").replace("\t", "\\t")
            try:
                extracted_data = json.loads(json_str)
            except Exception:
                json_str = original_json_str.replace("\\", "\\\\")
                extracted_data = json.loads(json_str)

        return extracted_data
    except Exception:
        return [1, 1]


def _is_valid_extracted_data(data: Any) -> bool:
    """Check that *data* is a list of dicts (valid extraction output)."""
    if not isinstance(data, list):
        return False
    return all(isinstance(item, dict) for item in data)


# ---------------------------------------------------------------------------
# Adapter + factory
# ---------------------------------------------------------------------------

class AgenticOCRExtractorAdapter:
    """Adapts ``AgenticOCR`` + ``ImageZoomOCRTool`` to the
    :class:`EvidenceExtractor` protocol.

    Encapsulates the multi-turn agent loop, tool call parsing, and JSON
    extraction.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model_name: str,
        mineru_api_token: str,
        mineru_model: str = "vlm",
        mineru_language: str = "ch",
        mineru_timeout: int = 600,
        max_image_size: int = 2048,
    ):
        self._base_url = base_url
        self._api_key = api_key
        self._model_name = model_name
        self._mineru_api_token = mineru_api_token
        self._mineru_model = mineru_model
        self._mineru_language = mineru_language
        self._mineru_timeout = mineru_timeout
        self._max_image_size = max_image_size

    def extract(self, image_path: str, query: str, work_dir: str = "",
                timeout: float = None) -> List[dict]:
        tool = ImageZoomOCRTool(
            work_dir=work_dir,
            mineru_api_token=self._mineru_api_token,
            mineru_model=self._mineru_model,
            mineru_language=self._mineru_language,
            mineru_timeout=self._mineru_timeout,
        )
        agent = AgenticOCR(
            base_url=self._base_url,
            api_key=self._api_key,
            model_name=self._model_name,
            tool=tool,
            max_image_size=self._max_image_size,
        )
        if timeout is not None:
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(_execute_agent_and_parse_json, agent, query, image_path)
                try:
                    extracted_data = future.result(timeout=timeout)
                except concurrent.futures.TimeoutError:
                    from doc_search.models import OperationTimeoutError
                    raise OperationTimeoutError(
                        operation="extractor",
                        reason="Evidence extractor service request timed out",
                        timeout=timeout,
                    )
        else:
            extracted_data = _execute_agent_and_parse_json(agent, query, image_path)
        if not _is_valid_extracted_data(extracted_data):
            return []
        return extracted_data


def create_extractor(config) -> Optional["AgenticOCRExtractorAdapter"]:
    """Factory: build an :class:`AgenticOCRExtractorAdapter` from *config*, or ``None``."""
    base_url = config.extractor_base_url
    if not base_url:
        return None
    return AgenticOCRExtractorAdapter(
        base_url=base_url,
        api_key=config.extractor_api_key,
        model_name=config.extractor_model_name,
        mineru_api_token=config.mineru_api_token,
        mineru_model=config.mineru_model,
        mineru_language=config.mineru_language,
        mineru_timeout=config.mineru_timeout,
        max_image_size=config.extractor_max_image_size,
    )
