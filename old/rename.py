import os

def rename_images(directory):
    # 获取目录下所有文件名
    files = os.listdir(directory)
    
    # 只保留图片文件
    image_files = [file for file in files if file.lower().endswith(('.jpg', '.jpeg', '.png', '.gif'))]
    
    # 对图片文件进行重新命名
    for i, file in enumerate(image_files):
        extension = '.jpg'  # 将扩展名修改为.jpg
        new_name = f"{str(i+1).zfill(5)}{extension}"  # 根据顺序生成新文件名，如00001.jpg、00002.jpg等
        old_path = os.path.join(directory, file)  # 原始文件路径
        new_path = os.path.join(directory, new_name)  # 新文件路径
        
        # 如果目标文件名已存在，生成新的不重复文件名
        while os.path.exists(new_path):
            i += 1
            new_name = f"{str(i).zfill(5)}{extension}"
            new_path = os.path.join(directory, new_name)
        
        # 重命名文件
        os.rename(old_path, new_path)

# 指定目录
directory = '../old/images'

# 调用函数进行重命名
rename_images(directory)
