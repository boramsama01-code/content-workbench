"""HighScoop category badge geometry shared with the Studio renderer.

Use the returned SVG as an image in HTML imports, with a separate native text
label. CSS border-radius is not the geometry transport between applications.
"""
from pathlib import Path
import base64
import json
import math
import re

CONTRACT_PATH = Path(__file__).resolve().parents[1] / 'assets/branding/highscoop-badge-contract.json'


def badge_contract():
    value = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
    if (value.get('version') != 1 or value.get('brand') != 'HighScoop' or value.get('shape') != 'capsule'
            or value.get('cornerRadiusRatio') != 0.5
            or value.get('pptxAdjustment') != 50000):
        raise ValueError('HighScoop category badges must have semicircular ends (radius = height / 2).')
    template = value.get('svgTemplate', '')
    rectangles = re.findall(r'<rect\b([^>]*)/?\s*>', template)
    expected = {'width': 'width', 'height': 'height', 'rx': 'radius', 'ry': 'radius', 'fill': 'color'}
    if (len(rectangles) != 1 or any(
            not re.search(r'(?:^|\s)' + name + r'="\{\{' + placeholder + r'\}\}"(?:\s|/|$)', rectangles[0])
            for name, placeholder in expected.items())
            or 'viewBox="0 0 {{width}} {{height}}"' not in template
            or 'data-highscoop-badge="capsule"' not in template):
        raise ValueError('The HighScoop SVG must preserve the shared dynamic capsule geometry.')
    return value


def badge_geometry(width, height):
    badge_contract()
    width, height = float(width), float(height)
    if not all(math.isfinite(v) for v in (width, height)) or height <= 0 or width < height:
        raise ValueError('A HighScoop capsule requires finite width >= height > 0.')
    return {'width': width, 'height': height, 'radius': height / 2, 'pptxAdjustment': 50000}


def create_badge_svg(width, height, color):
    values = badge_geometry(width, height)
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError('Badge color must be a six-digit hexadecimal color.')
    values['color'] = color
    svg = badge_contract()['svgTemplate']
    for name, value in values.items():
        svg = svg.replace('{{' + name + '}}', f'{value:g}' if isinstance(value, (int, float)) else value)
    if '{{' in svg:
        raise ValueError('The HighScoop badge template contains an unresolved field.')
    return svg


def badge_data_uri(width, height, color):
    return 'data:image/svg+xml;base64,' + base64.b64encode(create_badge_svg(width, height, color).encode()).decode()


def badge_html(width, height, color, left, top):
    """Decorative silhouette only; preserve the original native label separately."""
    values = badge_geometry(width, height)
    return (
        '<img data-highscoop-category-badge="capsule" alt="" '
        f'data-badge-width="{values["width"]:g}" data-badge-height="{values["height"]:g}" '
        f'src="{badge_data_uri(width, height, color)}" '
        f'style="position:absolute;left:{left:g}px;top:{top:g}px;'
        f'width:{values["width"]:g}px;height:{values["height"]:g}px;">'
    )


def badge_svg_image(width, height, color, left, top):
    values = badge_geometry(width, height)
    return (
        '<image data-highscoop-category-badge="capsule" '
        f'x="{left:g}" y="{top:g}" width="{values["width"]:g}" height="{values["height"]:g}" '
        f'href="{badge_data_uri(width, height, color)}"/>'
    )
