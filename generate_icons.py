import os
from PIL import Image

def generate_all_icons(source_icon_path="src-tauri/icons/icon.png", output_dir="src-tauri/icons/"):
    """
    Generates various icon sizes and formats from a source PNG icon.
    """
    if not os.path.exists(source_icon_path):
        print(f"错误：源图标文件未找到于 {source_icon_path}")
        return

    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"创建输出目录：{output_dir}")

    try:
        img = Image.open(source_icon_path).convert("RGBA")
    except Exception as e:
        print(f"错误：无法打开源图标文件 {source_icon_path}。错误信息：{e}")
        return

    icons_to_generate = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256), # 128 * 2
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (1024, 1024), # 假设 StoreLogo 需要高分辨率
    }

    # 生成 PNG 图标
    for filename, size in icons_to_generate.items():
        try:
            resized_img = img.resize(size, Image.Resampling.LANCZOS)
            output_path = os.path.join(output_dir, filename)
            resized_img.save(output_path)
            print(f"已生成：{output_path} (尺寸: {size[0]}x{size[1]})")
        except Exception as e:
            print(f"错误：生成 {filename} 失败。错误信息：{e}")

    # 生成 ICO 文件 (icon.ico)
    # ICO 文件可以包含多个尺寸，Pillow 会尝试包含一些常用尺寸
    # 通常，Pillow 会选择 16, 24, 32, 48, 64, 128, 256 这些尺寸中可用的
    # 这里我们指定一些常见的尺寸，Pillow 会尽力而为
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_output_path = os.path.join(output_dir, "icon.ico")
    try:
        # Pillow 的 save 方法的 sizes 参数用于 ICO
        img.save(ico_output_path, format="ICO", sizes=ico_sizes)
        print(f"已生成：{ico_output_path}")
    except Exception as e:
        print(f"错误：生成 icon.ico 失败。错误信息：{e}")

    # 生成 ICNS 文件 (icon.icns)
    # Pillow 对 ICNS 的支持比较基础，通常会使用最大的可用图像。
    # 为了更好的兼容性，Tauri 建议 ICNS 包含多个尺寸。
    # 这里我们尝试使用原始图像（假设它足够大）或一个特定的大尺寸（如 1024x1024）
    icns_output_path = os.path.join(output_dir, "icon.icns")
    try:
        # 尝试使用一个较大的尺寸来生成 ICNS，例如 512x512 或 1024x1024
        # 如果源图像小于此尺寸，它会被放大，可能导致质量下降
        # 更好的做法是确保源图像足够大
        icns_img_base_size = (1024, 1024)
        if img.width >= icns_img_base_size[0] and img.height >= icns_img_base_size[1]:
             icns_source_img = img.resize(icns_img_base_size, Image.Resampling.LANCZOS)
        else: # 如果源图太小，就用源图本身，避免过度放大
             icns_source_img = img 
        
        icns_source_img.save(icns_output_path, format="ICNS") # Pillow 会处理内部尺寸
        print(f"已生成：{icns_output_path}")
        print("提示：Pillow 生成的 .icns 文件可能比较基础。为获得最佳效果，尤其是在 macOS 上，建议使用 Apple 的 iconutil 工具。")
    except Exception as e:
        print(f"错误：生成 icon.icns 失败。错误信息：{e}")

if __name__ == "__main__":
    # 确保脚本在项目根目录运行时，路径正确
    project_root = os.path.dirname(os.path.abspath(__file__))
    source_file = os.path.join(project_root, "src-tauri/icons/icon.png")
    output_folder = os.path.join(project_root, "src-tauri/icons/")
    
    print(f"源图标: {source_file}")
    print(f"输出目录: {output_folder}")
    
    generate_all_icons(source_icon_path=source_file, output_dir=output_folder)
    print("\n图标生成完成。")
