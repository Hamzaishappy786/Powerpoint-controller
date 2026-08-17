"""
BLE GATT peripheral — fallback when WiFi is unavailable.
Run alongside server.js: node server.js is still required for WebSocket.
This script advertises as 'PPTX-Remote' and handles slide commands over BLE.
"""

import asyncio
import json
import subprocess
import logging
from bless import BlessServer, BlessGATTCharacteristic, GATTCharacteristicProperties, GATTAttributePermissions

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

SERVICE_UUID   = "12345678-1234-1234-1234-123456789abc"
CMD_CHAR_UUID  = "12345678-1234-1234-1234-123456789ab1"  # write (phone → PC)
STATE_CHAR_UUID = "12345678-1234-1234-1234-123456789ab2" # notify (PC → phone)

server: BlessServer = None
state_char: BlessGATTCharacteristic = None


def run_ps(script: str):
    try:
        result = subprocess.run(
            ["powershell", "-Command", script],
            capture_output=True, text=True, timeout=3
        )
        return result.stdout.strip()
    except Exception:
        return None


def get_slide_state() -> dict:
    cur = run_ps(
        "$app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application');"
        "$app.ActiveWindow.View.Slide.SlideIndex"
    )
    total = run_ps(
        "$app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application');"
        "$app.ActivePresentation.Slides.Count"
    )
    return {
        "current": int(cur) if cur and cur.isdigit() else 1,
        "total": int(total) if total and total.isdigit() else "?",
    }


def pptx_command(action: str, slide: int = None):
    if action == "next":
        run_ps(
            "$app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application');"
            "$app.ActiveWindow.View.Next()"
        )
    elif action == "prev":
        run_ps(
            "$app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application');"
            "$app.ActiveWindow.View.Previous()"
        )
    elif action == "goto" and slide:
        run_ps(
            f"$app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application');"
            f"$app.ActiveWindow.View.GotoSlide({slide})"
        )


def on_write(characteristic: BlessGATTCharacteristic, **kwargs):
    try:
        data = json.loads(characteristic.value.decode("utf-8"))
        action = data.get("action")
        pptx_command(action, data.get("slide"))

        # Notify updated state back to phone
        asyncio.get_event_loop().call_soon(push_state)
    except Exception as e:
        logger.error(f"Write handler error: {e}")


def push_state():
    global server, state_char
    if not server or not state_char:
        return
    state = get_slide_state()
    payload = json.dumps(state).encode("utf-8")
    state_char.value = bytearray(payload)
    server.update_value(SERVICE_UUID, STATE_CHAR_UUID)


async def poll_state(interval: float = 1.0):
    last = None
    while True:
        await asyncio.sleep(interval)
        state = get_slide_state()
        if state != last:
            last = state
            push_state()


async def main():
    global server, state_char

    server = BlessServer(name="PPTX-Remote", loop=asyncio.get_event_loop())
    server.read_request_func = None
    server.write_request_func = on_write

    await server.add_new_service(SERVICE_UUID)

    # Command characteristic: phone writes commands here
    await server.add_new_characteristic(
        SERVICE_UUID, CMD_CHAR_UUID,
        GATTCharacteristicProperties.write | GATTCharacteristicProperties.write_without_response,
        None,
        GATTAttributePermissions.writeable,
    )

    # State characteristic: phone subscribes to slide updates
    await server.add_new_characteristic(
        SERVICE_UUID, STATE_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        None,
        GATTAttributePermissions.readable,
    )

    state_char = server.get_characteristic(STATE_CHAR_UUID)

    await server.start()
    logger.info("BLE peripheral 'PPTX-Remote' is advertising. Waiting for phone...")

    # Push initial state
    push_state()
    await poll_state()


if __name__ == "__main__":
    asyncio.run(main())
