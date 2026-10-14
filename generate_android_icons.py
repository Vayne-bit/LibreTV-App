import os
import sys # For sys.exit
import traceback # For detailed error logging

try:
    from PIL import Image, ImageDraw, UnidentifiedImageError
except ImportError:
    error_message = "错误：Pillow 库未安装。请运行 'pip install Pillow' 来安装。"
    print(error_message)
    with open("android_icon_generation.log", "w", encoding="utf-8") as log_file:
        log_file.write(error_message + "\n")
    sys.exit(1)

LOG_FILE_NAME = "android_icon_generation.log"

def log_error(message):
    """Appends an error message to the log file."""
    with open(LOG_FILE_NAME, "a", encoding="utf-8") as log_file:
        log_file.write(message + "\n")
        log_file.write(traceback.format_exc() + "\n")
    print(message) # Also print to stdout for immediate feedback if visible

def create_circular_icon(image: Image.Image) -> Image.Image:
    """
    Converts a square image to a circular one by adding transparency to corners.
    """
    width, height = image.size
    if width != height:
        # Crop to square if not already, taking center
        min_dim = min(width, height)
        left = (width - min_dim) / 2
        top = (height - min_dim) / 2
        right = (width + min_dim) / 2
        bottom = (height + min_dim) / 2
        image = image.crop((left, top, right, bottom))
        width, height = image.size

    # Create a mask
    mask = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, width, height), fill=255)

    # Apply mask
    circular_img = image.copy()
    circular_img.putalpha(mask)
    return circular_img

def generate_android_mipmap_icons(source_icon_path="icon.png", output_base_dir="output_android_icons"):
    """
    Generates Android mipmap icons (ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png)
    for different densities from a source PNG icon.
    """
    if not os.path.exists(source_icon_path):
        err_msg = f"错误：源图标文件未找到于 {source_icon_path}"
        log_error(err_msg)
        return

    if not os.path.exists(output_base_dir):
        try:
            os.makedirs(output_base_dir)
            print(f"创建输出根目录：{output_base_dir}")
        except OSError as e:
            err_msg = f"错误：无法创建输出根目录 {output_base_dir}。错误信息：{e}"
            log_error(err_msg)
            return


    try:
        img = Image.open(source_icon_path).convert("RGBA")
    except UnidentifiedImageError:
        err_msg = f"错误：无法识别的图像文件格式于 {source_icon_path}。请确保它是一个有效的图像文件。"
        log_error(err_msg)
        return
    except Exception as e:
        err_msg = f"错误：无法打开源图标文件 {source_icon_path}。错误信息：{e}"
        log_error(err_msg)
        return

    # Android Mipmap densities and their corresponding sizes (in pixels)
    # Standard launcher icon size is 48dp.
    # mdpi: 48x48 (1.0x)
    # hdpi: 72x72 (1.5x)
    # xhdpi: 96x96 (2.0x)
    # xxhdpi: 144x144 (3.0x)
    # xxxhdpi: 192x192 (4.0x)
    mipmap_configs = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }

    for dirname, size in mipmap_configs.items():
        density_dir = os.path.join(output_base_dir, dirname)
        if not os.path.exists(density_dir):
            os.makedirs(density_dir)
            print(f"创建目录：{density_dir}")

        # --- Generate ic_launcher.png (square) ---
        try:
            resized_square_img = img.resize((size, size), Image.Resampling.LANCZOS)
            output_path_square = os.path.join(density_dir, "ic_launcher.png")
            resized_square_img.save(output_path_square, "PNG")
            print(f"  已生成：{output_path_square} (尺寸: {size}x{size})")
        except Exception as e:
            err_msg = f"  错误：生成 ic_launcher.png (尺寸: {size}x{size}) 失败。错误信息：{e}"
            log_error(err_msg)
            continue # Skip to next density if base square icon fails

        # --- Generate ic_launcher_round.png (circular) ---
        try:
            # Use the already resized square image as base for the round one
            circular_img = create_circular_icon(resized_square_img.copy())
            output_path_round = os.path.join(density_dir, "ic_launcher_round.png")
            circular_img.save(output_path_round, "PNG")
            print(f"  已生成：{output_path_round} (尺寸: {size}x{size})")
        except Exception as e:
            err_msg = f"  错误：生成 ic_launcher_round.png (尺寸: {size}x{size}) 失败。错误信息：{e}"
            log_error(err_msg)

        # --- Generate ic_launcher_foreground.png ---
        # For simplicity, using the same resized square image.
        # For true adaptive icons, this might need a different source or processing.
        # The foreground image should typically have some transparent padding
        # if it's not designed to fill the entire 108x108dp space.
        # Android's safe zone for foreground is center 72x72dp within a 108x108dp icon.
        # Here, we are generating icons at the final target density sizes (48, 72, etc.),
        # so the "safe zone" concept is relative to the original 108dp design.
        try:
            # We can reuse resized_square_img as the base for foreground
            output_path_foreground = os.path.join(density_dir, "ic_launcher_foreground.png")
            resized_square_img.save(output_path_foreground, "PNG") # Save as is
            print(f"  已生成：{output_path_foreground} (尺寸: {size}x{size})")
        except Exception as e:
            err_msg = f"  错误：生成 ic_launcher_foreground.png (尺寸: {size}x{size}) 失败。错误信息：{e}"
            log_error(err_msg)

    print("\nAndroid mipmap 图标生成完成。")

if __name__ == "__main__":
    # Clear log file at the beginning of a new run
    if os.path.exists(LOG_FILE_NAME):
        os.remove(LOG_FILE_NAME)

    try:
        # 默认源图标名称和输出目录
        default_source_icon = "icon.png"
        default_output_directory = "android_mipmap_icons"

        project_root_tauri_icon = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src-tauri", "icons", "icon.png")

        if os.path.exists(project_root_tauri_icon):
            source_file = project_root_tauri_icon
            print(f"检测到Tauri项目图标，将使用: {source_file}")
        elif os.path.exists(default_source_icon):
            source_file = default_source_icon
            print(f"将使用当前目录下的图标: {source_file}")
        else:
            err_msg = f"错误: 默认源图标 '{default_source_icon}' 或 '{project_root_tauri_icon}' 未找到。"
            log_error(err_msg)
            print(err_msg)
            print("请确保 'icon.png' 文件存在于脚本所在目录，或 'src-tauri/icons/icon.png' 相对于项目根目录存在，")
            print("或者在调用 generate_android_mipmap_icons 函数时提供正确的路径。")
            sys.exit(1)

        output_dir = default_output_directory

        print(f"源图标: {source_file}")
        print(f"输出目录: {output_dir}")

        generate_android_mipmap_icons(source_icon_path=source_file, output_base_dir=output_dir)

        print(f"\n请检查 '{output_dir}' 目录中的已生成图标。")
        print("你可以将这些 mipmap-* 文件夹复制到你的 Android 项目的 'app/src/main/res/' 目录下。")

    except Exception as e:
        final_error_msg = f"脚本执行过程中发生未捕获的严重错误: {e}"
        log_error(final_error_msg)
        print(final_error_msg)
        sys.exit(1)
