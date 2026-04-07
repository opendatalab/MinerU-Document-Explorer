import os
import uuid
import json
import math
import logging
from collections import defaultdict
from math import cos, sin, radians
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageOps

from mineru import MinerU


logger = logging.getLogger(__name__)


def smart_resize(
    height: int,
    width: int,
    factor: int = 32,
    min_pixels: int = 56 * 56,
    max_pixels: int = 12845056,
) -> Tuple[int, int]:
    """Smart resize: align image dimensions to multiples of *factor* within [min_pixels, max_pixels]."""
    def _round(n, f):
        return round(n / f) * f

    def _floor(n, f):
        return math.floor(n / f) * f

    def _ceil(n, f):
        return math.ceil(n / f) * f

    h_bar = max(factor, _round(height, factor))
    w_bar = max(factor, _round(width, factor))

    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((height * width) / max_pixels)
        h_bar = _floor(height / beta, factor)
        w_bar = _floor(width / beta, factor)
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (height * width))
        h_bar = _ceil(height * beta, factor)
        w_bar = _ceil(width * beta, factor)

    return h_bar, w_bar


def _make_mineru_client(token: str) -> MinerU:
    """Create a MinerU cloud SDK client."""
    return MinerU(token=token)


def _sdk_extract(client: MinerU, source: str, *,
                 model: str = "vlm", language: str = "ch",
                 timeout: int = 600) -> list:
    """Call MinerU SDK extract and return the content_list."""
    result = client.extract(
        source,
        model=model,
        language=language,
        timeout=timeout,
    )
    return result.content_list or []


def _parse_content_list(content_list: list) -> Tuple[str, List[dict]]:
    """Parse SDK content_list into (text, elements) for a single page/image.

    Returns:
        (text, elements) — text is newline-joined content; elements is a list
        of dicts with ``{"bbox": [x1,y1,x2,y2], "content": "..."}``.
        Bboxes are in 0-1000 normalised coordinates (SDK already uses this range).
    """
    texts: List[str] = []
    elements: List[dict] = []

    for item in content_list:
        content = _extract_text_from_item(item)
        if not content:
            continue
        texts.append(content)

        bbox = item.get("bbox", [0, 0, 1000, 1000])
        if len(bbox) != 4:
            bbox = [0, 0, 1000, 1000]

        elements.append({"bbox": bbox, "content": content})

    return "\n".join(texts), elements


def _extract_text_from_item(item: dict) -> str:
    """Extract text content from a single SDK content_list item."""
    # 'text' field covers text, title, equation types
    text = item.get("text", "")
    if text:
        return text.strip()
    # table_body for tables (HTML)
    table_body = item.get("table_body", "")
    if table_body:
        return table_body.strip()
    # code_body for code blocks
    code_body = item.get("code_body", "")
    if code_body:
        return code_body.strip()
    # list_items
    list_items = item.get("list_items", [])
    if list_items:
        return "\n".join(list_items).strip()
    return ""


def _parse_content_list_by_page(content_list: list) -> Dict[int, Tuple[str, List[dict]]]:
    """Group SDK content_list by page_idx and parse each page.

    Returns:
        dict mapping page_idx (0-based) to (text, elements) tuples.
    """
    by_page: Dict[int, list] = defaultdict(list)
    for item in content_list:
        page_idx = item.get("page_idx", 0)
        by_page[page_idx].append(item)

    result: Dict[int, Tuple[str, List[dict]]] = {}
    for page_idx, items in by_page.items():
        result[page_idx] = _parse_content_list(items)
    return result


class ImageZoomOCRTool:
    description = 'Zoom in on a specific region of an image by cropping it based on a bounding box (bbox), optionally rotate it or perform OCR.'

    def __init__(self, work_dir, mineru_api_token="", mineru_model="vlm",
                 mineru_language="ch", mineru_timeout=600):
        self.mineru_api_token = mineru_api_token
        self.mineru_model = mineru_model
        self.mineru_language = mineru_language
        self.mineru_timeout = mineru_timeout
        self.work_dir = work_dir

    def map_point_back(self, x, y,
                       final_size: Tuple[int, int],
                       rotated_size: Tuple[int, int],
                       crop_size: Tuple[int, int],
                       crop_offset: Tuple[int, int],
                       rotation_angle: float,
                       original_size: Tuple[int, int]) -> Tuple[int, int]:
        """
        Map a point from MinerU output coordinates (0-1000 relative on final_image)
        back to original image coordinates (0-1000 relative).
        """
        # 1. Convert relative (0-1000) on final image to absolute pixels on final image
        abs_x = x / 1000.0 * final_size[0]
        abs_y = y / 1000.0 * final_size[1]

        # 2. Undo Resize (Mapping from final_size back to rotated_size)
        scale_x = final_size[0] / rotated_size[0]
        scale_y = final_size[1] / rotated_size[1]

        abs_x = abs_x / scale_x
        abs_y = abs_y / scale_y

        # 3. Undo Rotation (Mapping from rotated_size back to crop_size)
        cx_rot, cy_rot = rotated_size[0] / 2.0, rotated_size[1] / 2.0
        cx_crop, cy_crop = crop_size[0] / 2.0, crop_size[1] / 2.0

        dx = abs_x - cx_rot
        dy = abs_y - cy_rot

        rad = radians(rotation_angle)
        cos_a = cos(rad)
        sin_a = sin(rad)

        rot_x = dx * cos_a - dy * sin_a
        rot_y = dx * sin_a + dy * cos_a

        orig_crop_x = rot_x + cx_crop
        orig_crop_y = rot_y + cy_crop

        # 4. Undo Crop (Add offset)
        final_abs_x = orig_crop_x + crop_offset[0]
        final_abs_y = orig_crop_y + crop_offset[1]

        # 5. Normalize to 0-1000 relative to original image
        norm_x = min(1000, max(0, int(final_abs_x / original_size[0] * 1000)))
        norm_y = min(1000, max(0, int(final_abs_y / original_size[1] * 1000)))

        return norm_x, norm_y

    def safe_crop_bbox(self, left, top, right, bottom, img_width, img_height):
        """Only clamp bbox to image bounds, without resizing or expanding it."""
        left = max(0, min(left, img_width))
        top = max(0, min(top, img_height))
        right = max(0, min(right, img_width))
        bottom = max(0, min(bottom, img_height))
        # Ensure valid order
        if left >= right:
            right = left + 1
        if top >= bottom:
            bottom = top + 1
        # Clamp again in case of degenerate
        right = min(right, img_width)
        bottom = min(bottom, img_height)
        return [left, top, right, bottom]

    def call(self, tool_call: dict, image_path) -> List[Any]:
        try:
            params = tool_call["arguments"]
            bbox = params['bbox']
            angle = params.get('angle', 0)
            type_ = params.get('type', "region")
        except Exception:
            logger.exception("Invalid tool call params: %s", tool_call)
            return [False, f'Error: Invalid tool_call params']

        os.makedirs(self.work_dir, exist_ok=True)

        try:
            image = Image.open(image_path)
        except Exception:
            logger.exception("Invalid input image: %s", image_path)
            return [False, f'Error: Invalid input image']

        try:
            # 1. Convert relative bbox (0-1000) to absolute pixels
            img_width, img_height = image.size
            rel_x1, rel_y1, rel_x2, rel_y2 = bbox
            abs_x1 = rel_x1 / 1000.0 * img_width
            abs_y1 = rel_y1 / 1000.0 * img_height
            abs_x2 = rel_x2 / 1000.0 * img_width
            abs_y2 = rel_y2 / 1000.0 * img_height

            # 2. ONLY clamp to image bounds — no resizing or padding!
            validated_bbox = self.safe_crop_bbox(abs_x1, abs_y1, abs_x2, abs_y2, img_width, img_height)
            left, top, right, bottom = validated_bbox

            # Record crop info for coordinate mapping
            crop_offset = (left, top)
            crop_size = (right - left, bottom - top)

            # 3. Crop the image (even if very small)
            cropped_image = image.crop((left, top, right, bottom))

            # 4. Rotate the image
            rotated_image = cropped_image.rotate(angle, expand=True)
            rotated_size = rotated_image.size

            new_h, new_w = smart_resize(
                height=rotated_size[1],
                width=rotated_size[0],
                factor=32,
                min_pixels=32 * 32,
                max_pixels=12845056,
            )
            final_image = rotated_image.resize((new_w, new_h), resample=Image.BICUBIC)
            final_size = final_image.size

            # Save processed image
            output_filename = f'{uuid.uuid4()}.png'
            output_path = os.path.abspath(os.path.join(self.work_dir, output_filename))
            final_image.save(output_path)

            if type_ == "image":
                return [True, output_path]

            # 6. OCR with MinerU SDK
            client = _make_mineru_client(self.mineru_api_token)
            content_list = _sdk_extract(
                client, output_path,
                model=self.mineru_model,
                language=self.mineru_language,
                timeout=self.mineru_timeout,
            )

            if type_ == "region":
                if content_list:
                    transformed_results = []
                    for item in content_list:
                        raw_bbox = item.get('bbox', [])
                        if not raw_bbox or len(raw_bbox) != 4:
                            continue

                        x1, y1, x2, y2 = raw_bbox

                        # Map back to original image coordinates
                        orig_x1, orig_y1 = self.map_point_back(
                            x1, y1, final_size, rotated_size, crop_size, crop_offset, angle, image.size
                        )
                        orig_x2, orig_y2 = self.map_point_back(
                            x2, y2, final_size, rotated_size, crop_size, crop_offset, angle, image.size
                        )

                        new_item = {
                            "type": item.get("type", "text"),
                            "content": _extract_text_from_item(item),
                            "bbox": [
                                min(orig_x1, orig_x2),
                                min(orig_y1, orig_y2),
                                max(orig_x1, orig_x2),
                                max(orig_y1, orig_y2),
                            ],
                            "angle": angle,
                        }
                        transformed_results.append(new_item)

                    ocr_text_output = json.dumps(transformed_results, ensure_ascii=False)
                else:
                    ocr_text_output = "MinerU returned empty result."

                return [
                    True,
                    output_path,
                    f"Region OCR Result (Mapped to original coords): {ocr_text_output}"
                ]
            else:
                # Filter content_list by requested type
                filtered = [
                    item for item in content_list
                    if item.get("type", "") == type_
                ]
                text, _ = _parse_content_list(filtered if filtered else content_list)
                return [
                    True,
                    output_path,
                    f"{type_.capitalize()} OCR Result: {text}"
                ]
        except Exception as e:
            obs = f'Tool Execution Error: {str(e)}'
            return [False, obs]


# ---------------------------------------------------------------------------
# Adapter + factory
# ---------------------------------------------------------------------------

class MinerUSDKOCRAdapter:
    """Adapts the MinerU cloud SDK to the :class:`OCRProvider` protocol."""

    def __init__(self, token: str, model: str = "vlm",
                 language: str = "ch", timeout: int = 600):
        self._token = token
        self._model = model
        self._language = language
        self._timeout = timeout

    def ocr_page(self, image_path: str) -> tuple[str, list[dict]]:
        """OCR a single page image via the MinerU SDK."""
        client = _make_mineru_client(self._token)
        content_list = _sdk_extract(
            client, image_path,
            model=self._model,
            language=self._language,
            timeout=self._timeout,
        )
        return _parse_content_list(content_list)

    def ocr_pdf(self, pdf_path: str) -> Dict[int, Tuple[str, list[dict]]]:
        """OCR an entire PDF at once via the MinerU SDK.

        Returns:
            dict mapping page_idx (0-based) to (text, elements) tuples.
        """
        client = _make_mineru_client(self._token)
        content_list = _sdk_extract(
            client, pdf_path,
            model=self._model,
            language=self._language,
            timeout=self._timeout,
        )
        return _parse_content_list_by_page(content_list)


def create_ocr(config) -> Optional["MinerUSDKOCRAdapter"]:
    """Factory: build a :class:`MinerUSDKOCRAdapter` from *config*, or ``None``."""
    token = config.mineru_api_token
    if not token:
        return None
    return MinerUSDKOCRAdapter(
        token=token,
        model=config.mineru_model,
        language=config.mineru_language,
        timeout=config.mineru_timeout,
    )
