import sys
sys.path.insert(0, "/home/varroa/.local/lib/python3.6/site-packages/")
import cv2
import numpy as np
import threading
import queue
import time
import os
import tensorrt as trt
import pycuda.driver as cuda
import pycuda.autoinit
from pycuda.tools import make_default_context
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst
import base64
import requests

# ------------------- Ayarlar -------------------

ENGINE_PATH = "yolov5s416.engine"
OUTPUT_DIR = "output"
MAX_QUEUE_SIZE = 20
INPUT_WIDTH, INPUT_HEIGHT = 416, 416  # Modelin beklediği giriş boyutu

# ------------------- Hazırlıklar -------------------

if not os.path.exists(OUTPUT_DIR):
    os.makedirs(OUTPUT_DIR)

frame_queue = queue.Queue(maxsize=MAX_QUEUE_SIZE)

# ------------------- Model Yükleme -------------------

def load_engine(engine_path):
    TRT_LOGGER = trt.Logger(trt.Logger.INFO)
    with open(engine_path, "rb") as f, trt.Runtime(TRT_LOGGER) as runtime:
        return runtime.deserialize_cuda_engine(f.read())
def do_nothing():
    return 0
def allocate_buffers(engine):
    inputs, outputs = [], []
    bindings = []
    stream = cuda.Stream()
    for binding in engine:
        size = trt.volume(engine.get_binding_shape(binding)) * engine.max_batch_size
        dtype = trt.nptype(engine.get_binding_dtype(binding))
        host_mem = cuda.pagelocked_empty(size, dtype)
        device_mem = cuda.mem_alloc(host_mem.nbytes)
        bindings.append(int(device_mem))
        if engine.binding_is_input(binding):
            inputs.append({'host': host_mem, 'device': device_mem})
        else:
            outputs.append({'host': host_mem, 'device': device_mem})
    return inputs, outputs, bindings, stream
  
def save_output_to_txt(output, save_path="output.txt", conf_threshold=0.5):
    num_detections = int(len(output) / 6)
    with open(save_path, "a") as f:  # "a" ile dosyayı append modunda açıyoruz
        f.write("\n--------------------------------\n")  # Yeni çağrıdan önce ayırıcı ekliyoruz
        for i in range(num_detections):
            index = i * 6
            x, y, w, h, conf, cls = output[index:index+6]
            if conf >= conf_threshold:
                f.write(f"{x} {y} {w} {h} {conf} {int(cls)}\n")

def preprocess(image):
    image_resized = cv2.resize(image, (INPUT_WIDTH, INPUT_HEIGHT))
    image_rgb = cv2.cvtColor(image_resized, cv2.COLOR_BGR2RGB)
    image_float = image_rgb.astype(np.float32) / 255.0
    img = np.transpose(image_float, (2, 0, 1))[np.newaxis, :]
    return np.ascontiguousarray(img, dtype=np.float32)

"""

def process_and_save_output(image, output, save_folder="output_folder", conf_threshold=0.5, frame_id="0"):
    image = cv2.resize(image, (416, 416))  # Görüntüyü boyutlandırma
    for i in range(0, len(output), 6):  # Her bir nesne için işlemi yapıyoruz
        x, y, w, h, conf, cls = output[i:i+6]
        if conf >= conf_threshold:
            # Koordinatları hesapla (merkezden dikdörtgenin köşelerine)
            x1 = int(x - w / 2)
            y1 = int(y - h / 2)
            x2 = int(x + w / 2)
            y2 = int(y + h / 2)
            
            # Sınıf ve güven eşiğine göre renk ve etiket belirleme
            if int(cls) == 0:  # Özel bir sınıf
                color = (0, 255, 0)  # Yeşil
            else:
                color = (255, 0, 0)  # Mavi
                
            # Dikdörtgeni çizme ve metni ekleme
            cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
            cv2.putText(image, f"{int(cls)}:{conf:.2f}", (x1, y1 - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
    
    # Kaydetme işlemi
    output_path = f"{save_folder}/output_visualized_{frame_id}.jpg"
    cv2.imwrite(output_path, image)  # Görüntüyü kaydet
    print(f"Output saved to {output_path}")
"""

def process_and_send_detection(image, output, base_url, user_id, hive_id, conf_threshold=0.5, frame_id="0"):
    """
    Detectionları işler ve eğer en az bir detection varsa HTTP isteği gönderir
    
    Args:
        image: OpenCV image array
        output: Detection output array 
        base_url: API base URL
        user_id: User ID for the request
        hive_id: Hive ID for the request
        conf_threshold: Confidence threshold for detections
        frame_id: Frame identifier
    """
    image = cv2.resize(image, (416, 416))  # Görüntüyü boyutlandırma
    detection_found = False
    
    # Detection kontrolü
    for i in range(0, len(output), 6):  # Her bir nesne için işlemi yapıyoruz
        x, y, w, h, conf, cls = output[i:i+6]
        if conf >= conf_threshold:
            detection_found = True
            
            # Koordinatları hesapla (merkezden dikdörtgenin köşelerine)
            x1 = int(x - w / 2)
            y1 = int(y - h / 2)
            x2 = int(x + w / 2)
            y2 = int(y + h / 2)
            
            # Sınıf ve güven eşiğine göre renk ve etiket belirleme
            if int(cls) == 0:  # Özel bir sınıf
                color = (0, 255, 0)  # Yeşil
            else:
                color = (255, 0, 0)  # Mavi
                
            # Dikdörtgeni çizme ve metni ekleme
            cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
            cv2.putText(image, f"{int(cls)}:{conf:.2f}", (x1, y1 - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
    
    # Eğer detection varsa HTTP isteği gönder
    if detection_found:
        try:
            # Görüntüyü base64'e çevir
            _, buffer = cv2.imencode('.jpg', image)
            image_base64 = base64.b64encode(buffer).decode("utf-8")
            
            # HTTP isteği gönder
            url = f"{base_url}/saveImage"
            payload = {
                "userId": user_id,
                "hiveId": hive_id,
                "imageData": image_base64
            }
            
            response = requests.post(url, json=payload)
            print(f"Detection found! HTTP request sent - Status: {response.status_code}, Response: {response.text}")
            
        except Exception as e:
            print(f"Error sending HTTP request: {e}")
    else:
        print(f"No detections found in frame {frame_id}")

def do_inference(context, bindings, inputs, outputs, stream, input_data):
    np.copyto(inputs[0]['host'], input_data.ravel())
    cuda.memcpy_htod_async(inputs[0]['device'], inputs[0]['host'], stream)
    context.execute_async_v2(bindings=bindings, stream_handle=stream.handle)
    cuda.memcpy_dtoh_async(outputs[0]['host'], outputs[0]['device'], stream)
    stream.synchronize()
    return outputs[0]['host']

# ------------------- Inference Thread -------------------

def inference_loop(engine):
    import pycuda.autoinit
    pycuda.autoinit.context.push()
    context = engine.create_execution_context()
    inputs, outputs, bindings, stream = allocate_buffers(engine)

    frame_id = 0
    while True:
        frame = frame_queue.get()
        if frame is None:
            break
        input_data = preprocess(frame)
        output = do_inference(context, bindings, inputs, outputs, stream, input_data)
        process_and_send_detection(frame, output,"https://us-central1-vargorback.cloudfunctions.net","testUserId","testHiveId",0.2, frame_id)
        frame_id += 1
        frame_queue.task_done()

# ------------------- Hareket Algılama -------------------

def hareket_var_mi(prev_frame, curr_frame):
    fark = cv2.absdiff(prev_frame, curr_frame)
    gri = cv2.cvtColor(fark, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gri, (25, 25), 0)  # Çok fazla blur
    _, thresh = cv2.threshold(blur, 60, 255, cv2.THRESH_BINARY)  # Yüksek threshold
    kontur, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return len(kontur) > 3  # Çok düşük kontur sayısı eşiği

# ------------------- GStreamer ile Görüntü Akışı -------------------

def start_gstreamer_loop():
    Gst.init(sys.argv)
    pipeline_str = (
    "tcambin name=source ! videoconvert ! video/x-raw,format=BGR ! appsink name=sink emit-signals=true max-buffers=1 drop=true"
    )
    pipeline = Gst.parse_launch(pipeline_str)
    sink = pipeline.get_by_name("sink")
    sink.set_property("emit-signals", True)
    pipeline.set_state(Gst.State.PLAYING)

    last_frame = None

    while True:
        sample = sink.emit("pull-sample")
        if sample is None:
          print("Sample alınamadı, boş geldi.")
          continue
        buf = sample.get_buffer()
        caps = sample.get_caps()
        struct = caps.get_structure(0)
        width = struct.get_value("width")
        height = struct.get_value("height")

        success, map_info = buf.map(Gst.MapFlags.READ)
        if not success:
            continue

        frame = np.ndarray((height, width, 3), buffer=map_info.data, dtype=np.uint8).copy()
        buf.unmap(map_info)

        if last_frame is None:
            last_frame = frame
            continue

        if hareket_var_mi(last_frame, frame):
            try:
                #print("Hareket Algılandı")
                frame_queue.put_nowait(frame)
            except queue.Full:
                #print("Kuyruk dolu, frame atlandı.")
                do_nothing()
        last_frame = frame

# ------------------- Ana Akış -------------------

if __name__ == "__main__":
    print("[INFO] Model yükleniyor...")
    engine = load_engine(ENGINE_PATH)
    print("[INFO] Model yüklendi.")

    print("[INFO] Inference thread başlatılıyor...")
    infer_thread = threading.Thread(target=inference_loop, args=(engine,))
    infer_thread.start()

    print("[INFO] GStreamer akışı başlıyor...")
    try:
        start_gstreamer_loop()
    except KeyboardInterrupt:
        print("[INFO] Çıkış yapılıyor...")

    frame_queue.put(None)
    infer_thread.join()
    print("[INFO] Sistem kapatıldı.")